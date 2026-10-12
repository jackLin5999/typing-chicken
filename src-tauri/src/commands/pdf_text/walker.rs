//! Content-stream interpreter: walks a decoded page stream and emits text.
//!
//! The job is not just "concatenate the strings" — the output has to keep the
//! document's line structure, because `split_into_chapters` in `parser.rs`
//! detects chapter headings *per line*. So the walker maintains the text
//! matrix and emits a newline whenever the baseline actually moves to a new
//! line.
//!
//! Matrices are the 3×2 PDF form `[a b c d e f]` applied to **row** vectors
//! (`[x y 1] · M`), so concatenating M1 then M2 is `M1 · M2`.

use std::sync::Arc;

use super::cmap::DecodeStat;
use super::font::FontDecoder;
use super::is_wide_cjk;
use super::lexer::{Lexer, Token};
use super::ExtractionStats;

const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// Nested `[` deeper than this is ignored rather than tracked.
const MAX_ARRAY_DEPTH: usize = 32;

/// A `TJ` number of `-150` means a gap of 0.15 em — the boundary between
/// kerning (20–120) and a real word space (200–350). TJ numbers are already in
/// thousandths of an em, so this test is font-size independent.
const TJ_SPACE_THRESHOLD: f64 = -150.0;

/// Vertical displacement above which the baseline counts as a new line.
/// 0.5 em sits between a sub/superscript (~0.3 em) and normal leading
/// (~1.1–1.5 em).
const LINE_TOLERANCE_EM: f64 = 0.5;

enum Value {
    Num(f64),
    Name(Vec<u8>),
    Str(Vec<u8>),
    Array(Vec<Value>),
    Dict,
}

impl Value {
    fn as_num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }

    fn as_name(&self) -> Option<&[u8]> {
        match self {
            Value::Name(n) => Some(n),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&[u8]> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
}

/// Graphics + text state. Both live in the graphics state stack: `q`/`Q` save
/// and restore the current font and size as well as the CTM.
#[derive(Clone)]
struct GState {
    ctm: [f64; 6],
    font: Option<Arc<FontDecoder>>,
    font_size: f64,
    leading: f64,
    horiz_scale: f64,
    vertical: bool,
}

impl Default for GState {
    fn default() -> Self {
        Self {
            ctm: IDENTITY,
            font: None,
            font_size: 0.0,
            leading: 0.0,
            horiz_scale: 1.0,
            vertical: false,
        }
    }
}

struct Walker<'a> {
    fonts: &'a [(Vec<u8>, Arc<FontDecoder>)],
    out: String,
    gstack: Vec<GState>,
    gs: GState,
    tm: [f64; 6],
    tlm: [f64; 6],
    /// Device-space `(baseline y, font size)` of the last emitted text.
    last: Option<(f64, f64)>,
    /// Tracked as a field rather than via `out.chars().last()`, which is O(n)
    /// on `Chars` and would make a whole book quadratic.
    last_char: Option<char>,
    pending_space: bool,
}

/// Extract the text of one content stream.
pub(crate) fn walk_page(
    content: &[u8],
    fonts: &[(Vec<u8>, Arc<FontDecoder>)],
    stats: &mut ExtractionStats,
) -> String {
    let mut walker = Walker {
        fonts,
        out: String::new(),
        gstack: Vec::new(),
        gs: GState::default(),
        tm: IDENTITY,
        tlm: IDENTITY,
        last: None,
        last_char: None,
        pending_space: false,
    };
    walker.run(content, stats);
    walker.out
}

impl<'a> Walker<'a> {
    fn run(&mut self, content: &[u8], stats: &mut ExtractionStats) {
        let mut lexer = Lexer::new(content);
        let mut operands: Vec<Value> = Vec::new();
        let mut arrays: Vec<Vec<Value>> = Vec::new();
        let mut dict_depth: u32 = 0;
        let mut array_overflow: u32 = 0;

        while let Some(token) = lexer.next_token() {
            match token {
                Token::DictOpen => {
                    dict_depth += 1;
                }
                Token::DictClose => {
                    if dict_depth > 0 {
                        dict_depth -= 1;
                        if dict_depth == 0 {
                            push_value(&mut operands, &mut arrays, array_overflow, Value::Dict);
                        }
                    }
                }
                // The inside of a property dict is never needed; skipping it
                // keeps a `/Properties <<…>>` from polluting the operands.
                _ if dict_depth > 0 => {}
                Token::ArrayOpen => {
                    if array_overflow > 0 {
                        array_overflow += 1;
                    } else if arrays.len() >= MAX_ARRAY_DEPTH {
                        array_overflow = 1;
                    } else {
                        arrays.push(Vec::new());
                    }
                }
                Token::ArrayClose => {
                    if array_overflow > 0 {
                        array_overflow -= 1;
                    } else if let Some(items) = arrays.pop() {
                        push_value(&mut operands, &mut arrays, 0, Value::Array(items));
                    }
                }
                Token::Int(v) => {
                    push_value(&mut operands, &mut arrays, array_overflow, Value::Num(v as f64))
                }
                Token::Real(v) => {
                    push_value(&mut operands, &mut arrays, array_overflow, Value::Num(v))
                }
                Token::Name(name) => push_value(
                    &mut operands,
                    &mut arrays,
                    array_overflow,
                    Value::Name(name.into_owned()),
                ),
                Token::Str(s) => {
                    push_value(&mut operands, &mut arrays, array_overflow, Value::Str(s))
                }
                Token::Keyword(keyword) => {
                    if keyword == b"BI" {
                        // Must happen before the operands are cleared, because
                        // the payload starts right after this keyword.
                        lexer.skip_inline_image();
                    } else {
                        self.operator(keyword, &operands, stats);
                    }
                    operands.clear();
                }
            }
        }
    }

    fn operator(&mut self, keyword: &[u8], operands: &[Value], stats: &mut ExtractionStats) {
        match keyword {
            b"q" => self.gstack.push(self.gs.clone()),
            b"Q" => {
                if let Some(state) = self.gstack.pop() {
                    self.gs = state;
                }
            }
            b"cm" => {
                if let Some(matrix) = as_matrix(operands) {
                    // The spec concatenates the new matrix on the left.
                    self.gs.ctm = concat(&matrix, &self.gs.ctm);
                }
            }
            b"BT" => {
                self.tm = IDENTITY;
                self.tlm = IDENTITY;
            }
            b"Tf" => {
                let name = operands.first().and_then(Value::as_name);
                let size = operands.get(1).and_then(Value::as_num);
                if let (Some(name), Some(size)) = (name, size) {
                    let font = self
                        .fonts
                        .iter()
                        .find(|(font_name, _)| font_name == name)
                        .map(|(_, decoder)| decoder.clone());
                    self.gs.vertical = font.as_ref().is_some_and(|f| f.vertical);
                    self.gs.font = font;
                    self.gs.font_size = size;
                }
            }
            b"TL" => {
                if let Some(value) = operands.last().and_then(Value::as_num) {
                    self.gs.leading = value;
                }
            }
            b"Tz" => {
                if let Some(value) = operands.last().and_then(Value::as_num) {
                    self.gs.horiz_scale = value / 100.0;
                }
            }
            b"Td" => self.move_text(operands, false),
            b"TD" => self.move_text(operands, true),
            b"Tm" => {
                if let Some(matrix) = as_matrix(operands) {
                    self.tm = matrix;
                    self.tlm = matrix;
                }
            }
            b"T*" => self.next_line(),
            b"Tj" => {
                stats.text_show_ops += 1;
                if let Some(text) = operands.first().and_then(Value::as_str) {
                    self.show(text, stats);
                }
            }
            b"'" => {
                stats.text_show_ops += 1;
                self.next_line();
                if let Some(text) = operands.first().and_then(Value::as_str) {
                    self.show(text, stats);
                }
            }
            b"\"" => {
                stats.text_show_ops += 1;
                self.next_line();
                if let Some(text) = operands.last().and_then(Value::as_str) {
                    self.show(text, stats);
                }
            }
            b"TJ" => {
                stats.text_show_ops += 1;
                if let Some(Value::Array(items)) = operands.first() {
                    for item in items {
                        match item {
                            Value::Num(n) if *n <= TJ_SPACE_THRESHOLD => self.pending_space = true,
                            Value::Str(text) => self.show(text, stats),
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn move_text(&mut self, operands: &[Value], set_leading: bool) {
        let tx = operands.first().and_then(Value::as_num).unwrap_or(0.0);
        let ty = operands.get(1).and_then(Value::as_num).unwrap_or(0.0);
        self.tlm = concat(&[1.0, 0.0, 0.0, 1.0, tx, ty], &self.tlm);
        self.tm = self.tlm;
        if set_leading {
            self.gs.leading = -ty;
        }
    }

    fn next_line(&mut self) {
        self.tlm = concat(&[1.0, 0.0, 0.0, 1.0, 0.0, -self.gs.leading], &self.tlm);
        self.tm = self.tlm;
    }

    fn show(&mut self, bytes: &[u8], stats: &mut ExtractionStats) {
        let Some(font) = self.gs.font.clone() else {
            stats.unmapped_codes += bytes.len();
            return;
        };

        let (baseline_y, size) = self.device_baseline();

        if self.gs.vertical {
            // A vertical run advances along x, so comparing baseline y is
            // meaningless — emit the text but never break a line on it.
            self.pending_space = false;
        } else if !self.out.is_empty() {
            if let Some((previous_y, previous_size)) = self.last {
                let tolerance = LINE_TOLERANCE_EM * size.max(previous_size);
                if (baseline_y - previous_y).abs() > tolerance && !self.out.ends_with('\n') {
                    self.out.push('\n');
                    self.pending_space = false;
                }
            }
        }

        let mut piece = String::new();
        let mut stat = DecodeStat::default();
        font.decode(bytes, &mut piece, &mut stat);
        stats.mapped_codes += stat.mapped;
        stats.unmapped_codes += stat.unmapped;

        if piece.is_empty() {
            return;
        }

        if self.pending_space {
            if should_insert_space(self.last_char, piece.chars().next(), &self.out) {
                self.out.push(' ');
            }
            self.pending_space = false;
        }

        self.out.push_str(&piece);
        self.last_char = piece.chars().last();
        self.last = Some((baseline_y, size));
    }

    /// Device-space baseline of the current text position and the font size in
    /// device units, both derived from `Trm = Tsm · Tm · CTM`.
    fn device_baseline(&self) -> (f64, f64) {
        let trm = concat(&self.tm, &self.gs.ctm);
        // The text-space unit-y vector maps to the second column of Trm; its
        // length is the em size on the device. The horizontal scale `Tz` does
        // not enter because we measure the vertical vector.
        let size = (self.gs.font_size * trm[2].hypot(trm[3])).abs();
        (trm[5], if size > 0.0 { size } else { 12.0 })
    }
}

fn push_value(
    operands: &mut Vec<Value>,
    arrays: &mut [Vec<Value>],
    overflow: u32,
    value: Value,
) {
    if overflow > 0 {
        return;
    }
    match arrays.last_mut() {
        Some(current) => current.push(value),
        None => operands.push(value),
    }
}

fn as_matrix(operands: &[Value]) -> Option<[f64; 6]> {
    if operands.len() < 6 {
        return None;
    }
    let start = operands.len() - 6;
    let mut matrix = [0.0; 6];
    for (index, slot) in matrix.iter_mut().enumerate() {
        *slot = operands[start + index].as_num()?;
    }
    Some(matrix)
}

/// `M1 · M2` in the row-vector convention — PDF's matrix concatenation.
fn concat(m1: &[f64; 6], m2: &[f64; 6]) -> [f64; 6] {
    [
        m1[0] * m2[0] + m1[1] * m2[2],
        m1[0] * m2[1] + m1[1] * m2[3],
        m1[2] * m2[0] + m1[3] * m2[2],
        m1[2] * m2[1] + m1[3] * m2[3],
        m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
        m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
    ]
}

/// A `TJ` gap becomes a space only between two narrow characters. This guard
/// is the whole point: CJK producers routinely emit one `Tj` per glyph and use
/// large offsets for positioning that are numerically indistinguishable from
/// word spaces, so an unguarded rule shreds Chinese text with stray spaces.
fn should_insert_space(last: Option<char>, next: Option<char>, out: &str) -> bool {
    if out.is_empty() || out.ends_with(char::is_whitespace) {
        return false;
    }
    match (last, next) {
        (Some(a), Some(b)) => !is_wide_cjk(a) && !is_wide_cjk(b),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::pdf_text::cmap::CMap;
    use crate::commands::pdf_text::font::test_decoder;

    /// A font whose two-byte codes map to the digits 0–9, so tests can assert
    /// on exact strings.
    fn digits_font() -> Arc<FontDecoder> {
        let mut cmap_text = String::from("1 begincodespacerange <0000> <FFFF> endcodespacerange\n");
        cmap_text.push_str("10 beginbfchar\n");
        for d in 0..10u32 {
            cmap_text.push_str(&format!("<{:04X}> <{:04X}>\n", 0x3000 + d, 0x30 + d));
        }
        cmap_text.push_str("endbfchar");
        Arc::new(test_decoder(CMap::parse(cmap_text.as_bytes(), 2), false))
    }

    /// A font mapping the two-byte codes `0001`/`0002` to CJK characters.
    fn cjk_font() -> Arc<FontDecoder> {
        let cmap = CMap::parse(
            b"1 begincodespacerange <0000> <FFFF> endcodespacerange \
              2 beginbfchar <0001> <4E2D> <0002> <6587> endbfchar",
            2,
        );
        Arc::new(test_decoder(cmap, false))
    }

    fn run(content: &[u8], fonts: &[(Vec<u8>, Arc<FontDecoder>)]) -> String {
        let mut stats = ExtractionStats::default();
        walk_page(content, fonts, &mut stats)
    }

    fn digits() -> Vec<(Vec<u8>, Arc<FontDecoder>)> {
        vec![(b"F1".to_vec(), digits_font())]
    }

    #[test]
    fn concatenation_matches_the_spec() {
        // translate(3,4) then scale(2,2): a point at the origin must land at
        // (6,8) = (3·2, 4·2).
        let result = concat(&[1.0, 0.0, 0.0, 1.0, 3.0, 4.0], &[2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
        assert_eq!(result, [2.0, 0.0, 0.0, 2.0, 6.0, 8.0]);
    }

    #[test]
    fn identity_is_neutral_on_both_sides() {
        let m = [2.0, 0.0, 0.0, 3.0, 7.0, 11.0];
        assert_eq!(concat(&IDENTITY, &m), m);
        assert_eq!(concat(&m, &IDENTITY), m);
    }

    #[test]
    fn a_downward_move_breaks_the_line() {
        // `Td` is *relative*: 0 -12 moves 12 units down from the current line
        // matrix, which at 10pt is more than the 0.5 em tolerance.
        let text = run(
            b"BT /F1 10 Tf 50 700 Td <3000> Tj 0 -12 Td <3001> Tj ET",
            &digits(),
        );
        assert_eq!(text, "0\n1");
    }

    #[test]
    fn a_horizontal_move_does_not_break_the_line() {
        let text = run(
            b"BT /F1 10 Tf 50 700 Td <3000> Tj 10 0 Td <3001> Tj ET",
            &digits(),
        );
        assert_eq!(text, "01");
    }

    #[test]
    fn a_superscript_shift_stays_on_the_same_line() {
        // 3 units up at 10pt is 0.3 em, inside the 0.5 em tolerance.
        let text = run(
            b"BT /F1 10 Tf 50 700 Td <3000> Tj 0 3 Td <3001> Tj ET",
            &digits(),
        );
        assert_eq!(text, "01");
    }

    #[test]
    fn a_font_size_change_does_not_itself_break_a_line() {
        // `Tm` is absolute, so the second string sits on the same baseline.
        let text = run(
            b"BT /F1 10 Tf 50 700 Td <3000> Tj /F1 20 Tf 1 0 0 1 50 700 Tm <3001> Tj ET",
            &digits(),
        );
        assert_eq!(text, "01");
    }

    #[test]
    fn a_relative_move_down_by_exactly_the_tolerance_does_not_break() {
        // 5 units at 10pt is exactly the 0.5 em boundary; the test is strict,
        // so this must stay on the line.
        let text = run(
            b"BT /F1 10 Tf 50 700 Td <3000> Tj 0 -5 Td <3001> Tj ET",
            &digits(),
        );
        assert_eq!(text, "01");
    }

    #[test]
    fn kerning_gaps_do_not_becomes_spaces() {
        let text = run(
            b"BT /F1 10 Tf 50 700 Td [<3000> -120 <3001>] TJ ET",
            &digits(),
        );
        assert_eq!(text, "01");
    }

    #[test]
    fn a_large_tj_gap_becomes_one_space() {
        let text = run(
            b"BT /F1 10 Tf 50 700 Td [<3000> -250 <3001>] TJ ET",
            &digits(),
        );
        assert_eq!(text, "0 1");
    }

    #[test]
    fn consecutive_large_gaps_still_yield_a_single_space() {
        let text = run(
            b"BT /F1 10 Tf 50 700 Td [<3000> -250 -250 <3001>] TJ ET",
            &digits(),
        );
        assert_eq!(text, "0 1");
    }

    #[test]
    fn positive_tj_numbers_are_never_spaces() {
        let text = run(
            b"BT /F1 10 Tf 50 700 Td [<3000> 250 <3001>] TJ ET",
            &digits(),
        );
        assert_eq!(text, "01");
    }

    #[test]
    fn a_large_gap_between_cjk_characters_is_not_a_space() {
        let fonts = vec![(b"F1".to_vec(), cjk_font())];
        let text = run(
            b"BT /F1 10 Tf 50 700 Td [<0001> -400 <0002>] TJ ET",
            &fonts,
        );
        assert_eq!(text, "中文");
    }

    #[test]
    fn identity_h_codes_decode_to_characters() {
        let fonts = vec![(b"F1".to_vec(), cjk_font())];
        let text = run(b"BT /F1 24 Tf 72 700 Td <00010002> Tj ET", &fonts);
        assert_eq!(text, "中文");
    }

    #[test]
    fn tj_arrays_split_across_strings_join_without_separators() {
        let fonts = vec![(b"F1".to_vec(), cjk_font())];
        let text = run(b"BT /F1 24 Tf 72 700 Td [<0001> <0002>] TJ ET", &fonts);
        assert_eq!(text, "中文");
    }

    #[test]
    fn q_and_q_restore_the_font() {
        let text = run(
            b"BT /F1 10 Tf 50 700 Td <3000> Tj q /Nonexistent 40 Tf 0 -12 Td <3001> Tj Q \
              /F1 10 Tf 0 -12 Td <3001> Tj ET",
            &digits(),
        );
        // The middle string draws with an unknown font, so it is dropped; the
        // outer two still decode after Q restores the state.
        assert_eq!(text, "0\n1");
    }

    #[test]
    fn text_after_an_inline_image_is_not_lost() {
        let text = run(
            b"BT /F1 10 Tf 50 700 Td <3000> Tj ET \
              BI /W 2 /H 2 /BPC 8 /CS /G ID \x00)E\x01 EI \
              BT /F1 10 Tf 50 688 Td <3001> Tj ET",
            &digits(),
        );
        assert_eq!(text, "0\n1");
    }

    #[test]
    fn unknown_operators_and_odd_operands_are_tolerated() {
        let text = run(
            b"1 0 0 1 0 0 cm 0.5 g BT /F1 10 Tf 50 700 Td \
              (ignored) Tj <3000> Tj 0 Tr 3 Tr <3001> Tj ET",
            &digits(),
        );
        // Invisible render mode (Tr 3) must NOT be skipped: it is exactly what
        // an OCR text layer uses.
        assert!(text.starts_with("01"), "got {:?}", text);
    }

    #[test]
    fn each_downward_step_breaks_exactly_once() {
        let text = run(
            b"BT /F1 10 Tf 50 700 Td <3000> Tj 0 -40 Td <3001> Tj 0 -40 Td <3001> Tj ET",
            &digits(),
        );
        assert_eq!(text, "0\n1\n1");
    }
}
