//! Minimal PDF token lexer, shared by the content-stream walker and the
//! ToUnicode CMap parser.
//!
//! Deliberately *not* a general PDF object parser: no indirect references
//! (`R`), no booleans, no `null`. It handles exactly the token kinds that
//! appear in content streams and CMap programs, plus `BI…ID…EI` inline
//! images — which `lopdf`'s own `Content::decode` (nom_parser.rs:488) silently
//! truncates at, losing all text drawn after the image on that page.

use std::borrow::Cow;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Token<'a> {
    Int(i64),
    Real(f64),
    /// `/Name` with the leading slash stripped and `#xx` escapes resolved.
    Name(Cow<'a, [u8]>),
    /// Literal `(...)` or hex `<...>` string, escapes already resolved.
    Str(Vec<u8>),
    ArrayOpen,
    ArrayClose,
    DictOpen,
    DictClose,
    /// Operator or bare keyword (`Tf`, `TJ`, `beginbfchar`, `{`, …).
    Keyword(&'a [u8]),
}

pub(crate) struct Lexer<'a> {
    input: &'a [u8],
    pos: usize,
}

/// A `(` deeper than this is treated as a literal byte rather than a nesting
/// token. Without a cap, a hostile 200-deep `((((…` overflows the stack — and
/// a stack overflow *aborts the process*, so `catch_unwind` in `parser.rs`
/// cannot save us. lopdf's own reader uses the same 100 limit.
const MAX_STRING_NESTING: u32 = 100;

impl<'a> Lexer<'a> {
    pub fn new(input: &'a [u8]) -> Self {
        Self { input, pos: 0 }
    }

    /// Skip the binary payload of an inline image — call immediately after
    /// receiving a `BI` keyword. The payload cannot be tokenized, so scan the
    /// raw bytes for an `EI` delimited on both sides, the same heuristic
    /// pdf.js uses. False positives inside image data are possible but rare
    /// because of the whitespace requirement.
    pub fn skip_inline_image(&mut self) {
        while self.pos < self.input.len() {
            if self.input[self.pos] == b'E'
                && self.input.get(self.pos + 1) == Some(&b'I')
                && (self.pos == 0 || is_ws_or_delim(self.input[self.pos - 1]))
                && self
                    .input
                    .get(self.pos + 2)
                    .map_or(true, |&b| is_ws_or_delim(b))
            {
                self.pos += 2;
                return;
            }
            self.pos += 1;
        }
    }

    /// Returns the next token, or `None` at end of input.
    ///
    /// Guarantees forward progress: every call that returns `None` or skips a
    /// byte has advanced `pos`, so a malformed byte sequence can never spin
    /// this loop forever.
    pub fn next_token(&mut self) -> Option<Token<'a>> {
        self.skip_ws_and_comments();
        while self.pos < self.input.len() {
            let start = self.pos;
            if let Some(tok) = self.scan_token() {
                return Some(tok);
            }
            // Not a token here — step over the offending byte and retry.
            if self.pos == start {
                self.pos += 1;
            }
            self.skip_ws_and_comments();
        }
        None
    }

    fn skip_ws_and_comments(&mut self) {
        loop {
            while self.pos < self.input.len() && is_whitespace(self.input[self.pos]) {
                self.pos += 1;
            }
            if self.pos < self.input.len() && self.input[self.pos] == b'%' {
                while self.pos < self.input.len() && !is_eol(self.input[self.pos]) {
                    self.pos += 1;
                }
                continue;
            }
            return;
        }
    }

    fn scan_token(&mut self) -> Option<Token<'a>> {
        let b = self.input[self.pos];
        match b {
            b'[' => {
                self.pos += 1;
                Some(Token::ArrayOpen)
            }
            b']' => {
                self.pos += 1;
                Some(Token::ArrayClose)
            }
            b'<' => {
                if self.input.get(self.pos + 1) == Some(&b'<') {
                    self.pos += 2;
                    Some(Token::DictOpen)
                } else {
                    Some(Token::Str(self.read_hex_string()))
                }
            }
            b'>' => {
                if self.input.get(self.pos + 1) == Some(&b'>') {
                    self.pos += 2;
                    Some(Token::DictClose)
                } else {
                    // A stray `>` is not a token; let the caller step over it.
                    None
                }
            }
            b'{' | b'}' => {
                let start = self.pos;
                self.pos += 1;
                Some(Token::Keyword(&self.input[start..self.pos]))
            }
            b'(' => Some(Token::Str(self.read_literal_string())),
            b'/' => Some(Token::Name(self.read_name())),
            b'+' | b'-' | b'.' | b'0'..=b'9' => self.read_number(),
            _ if is_regular(b) => Some(Token::Keyword(self.read_keyword())),
            _ => None,
        }
    }

    fn read_name(&mut self) -> Cow<'a, [u8]> {
        self.pos += 1; // consume '/'
        let start = self.pos;
        while self.pos < self.input.len() && !is_ws_or_delim(self.input[self.pos]) {
            self.pos += 1;
        }
        let raw = &self.input[start..self.pos];
        if !raw.contains(&b'#') {
            return Cow::Borrowed(raw);
        }
        let mut out = Vec::with_capacity(raw.len());
        let mut i = 0;
        while i < raw.len() {
            if raw[i] == b'#' && i + 2 < raw.len() {
                if let (Some(hi), Some(lo)) = (hex_val(raw[i + 1]), hex_val(raw[i + 2])) {
                    out.push(hi << 4 | lo);
                    i += 3;
                    continue;
                }
            }
            out.push(raw[i]);
            i += 1;
        }
        Cow::Owned(out)
    }

    fn read_keyword(&mut self) -> &'a [u8] {
        let start = self.pos;
        while self.pos < self.input.len() && is_regular(self.input[self.pos]) {
            self.pos += 1;
        }
        &self.input[start..self.pos]
    }

    fn read_number(&mut self) -> Option<Token<'a>> {
        let start = self.pos;
        let mut has_dot = false;
        let mut has_digit = false;

        if matches!(self.input.get(self.pos), Some(b'+') | Some(b'-')) {
            self.pos += 1;
        }
        while self.pos < self.input.len() {
            match self.input[self.pos] {
                b'0'..=b'9' => {
                    has_digit = true;
                    self.pos += 1;
                }
                b'.' if !has_dot => {
                    has_dot = true;
                    self.pos += 1;
                }
                _ => break,
            }
        }

        if !has_digit {
            // A bare `-` or `.` is not a number. Rewind so the caller advances
            // past it as an unknown byte.
            self.pos = start;
            return None;
        }

        // `4.`, `.5` and `-.5` are all valid per the spec.
        let text = std::str::from_utf8(&self.input[start..self.pos]).ok()?;
        if has_dot {
            text.parse::<f64>().ok().map(Token::Real)
        } else {
            // Integers past i64 (a huge /Length, say) keep their value as f64
            // rather than being dropped.
            match text.parse::<i64>() {
                Ok(v) => Some(Token::Int(v)),
                Err(_) => text.parse::<f64>().ok().map(Token::Real),
            }
        }
    }

    /// `( ... )` with escapes resolved. Iterative, never recursive.
    fn read_literal_string(&mut self) -> Vec<u8> {
        self.pos += 1; // consume '('
        let mut out = Vec::new();
        let mut depth: u32 = 1;

        while self.pos < self.input.len() {
            let b = self.input[self.pos];
            match b {
                b'\\' => {
                    self.pos += 1;
                    self.read_escape(&mut out);
                }
                b'(' => {
                    if depth < MAX_STRING_NESTING {
                        depth += 1;
                    }
                    out.push(b);
                    self.pos += 1;
                }
                b')' => {
                    depth -= 1;
                    self.pos += 1;
                    if depth == 0 {
                        break;
                    }
                    out.push(b);
                }
                b'\r' => {
                    // The spec normalizes a raw CR / CRLF inside a string to a
                    // single LF (lopdf does not; this is more correct).
                    self.pos += 1;
                    if self.input.get(self.pos) == Some(&b'\n') {
                        self.pos += 1;
                    }
                    out.push(b'\n');
                }
                b'\n' => {
                    out.push(b'\n');
                    self.pos += 1;
                }
                _ => {
                    out.push(b);
                    self.pos += 1;
                }
            }
        }

        out
    }

    fn read_escape(&mut self, out: &mut Vec<u8>) {
        if self.pos >= self.input.len() {
            return;
        }
        match self.input[self.pos] {
            b'n' => {
                out.push(b'\n');
                self.pos += 1;
            }
            b'r' => {
                out.push(b'\r');
                self.pos += 1;
            }
            b't' => {
                out.push(b'\t');
                self.pos += 1;
            }
            b'b' => {
                out.push(0x08);
                self.pos += 1;
            }
            b'f' => {
                out.push(0x0C);
                self.pos += 1;
            }
            b'(' => {
                out.push(b'(');
                self.pos += 1;
            }
            b')' => {
                out.push(b')');
                self.pos += 1;
            }
            b'\\' => {
                out.push(b'\\');
                self.pos += 1;
            }
            b'0'..=b'7' => {
                let mut val: u32 = 0;
                let mut n = 0;
                while n < 3 && self.pos < self.input.len() {
                    let d = self.input[self.pos];
                    if !(b'0'..=b'7').contains(&d) {
                        break;
                    }
                    val = val * 8 + (d - b'0') as u32;
                    self.pos += 1;
                    n += 1;
                }
                // `\400` (256) truncates to 0x00, matching lopdf's oct_char.
                out.push(val as u8);
            }
            b'\r' => {
                // Backslash before EOL: a line continuation, emits nothing.
                self.pos += 1;
                if self.input.get(self.pos) == Some(&b'\n') {
                    self.pos += 1;
                }
            }
            b'\n' => {
                self.pos += 1;
            }
            other => {
                // Unknown escape: the character stands for itself.
                out.push(other);
                self.pos += 1;
            }
        }
    }

    fn read_hex_string(&mut self) -> Vec<u8> {
        self.pos += 1; // consume '<'
        let mut out = Vec::new();
        let mut hi: Option<u8> = None;

        while self.pos < self.input.len() {
            let b = self.input[self.pos];
            self.pos += 1;
            if b == b'>' {
                break;
            }
            // Whitespace and stray non-hex bytes inside are ignored.
            if let Some(v) = hex_val(b) {
                match hi {
                    None => hi = Some(v),
                    Some(h) => {
                        out.push(h << 4 | v);
                        hi = None;
                    }
                }
            }
        }

        if let Some(h) = hi {
            // Odd nibble count: the final nibble is the high half of the last
            // byte, low half zero — `<4E2>` is 4E 20.
            out.push(h << 4);
        }

        out
    }
}

impl<'a> Iterator for Lexer<'a> {
    type Item = Token<'a>;

    fn next(&mut self) -> Option<Token<'a>> {
        self.next_token()
    }
}

fn is_eol(b: u8) -> bool {
    b == b'\n' || b == b'\r'
}

/// The spec's whitespace set, including NUL — padding bytes appear in the wild
/// (lopdf's `content_space` omits NUL).
fn is_whitespace(b: u8) -> bool {
    matches!(b, 0 | b'\t' | b'\n' | b'\x0C' | b'\r' | b' ')
}

fn is_delimiter(b: u8) -> bool {
    matches!(
        b,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn is_ws_or_delim(b: u8) -> bool {
    is_whitespace(b) || is_delimiter(b)
}

fn is_regular(b: u8) -> bool {
    !is_ws_or_delim(b)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(data: &[u8]) -> Vec<Token<'_>> {
        Lexer::new(data).collect()
    }

    fn strs(data: &[u8]) -> Vec<Vec<u8>> {
        tokens(data)
            .into_iter()
            .filter_map(|t| match t {
                Token::Str(s) => Some(s),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn numbers_in_every_legal_shape() {
        assert_eq!(
            tokens(b"1 -2 +3 4.5 -.5 6."),
            vec![
                Token::Int(1),
                Token::Int(-2),
                Token::Int(3),
                Token::Real(4.5),
                Token::Real(-0.5),
                Token::Real(6.0),
            ]
        );
    }

    #[test]
    fn a_bare_sign_is_not_a_number() {
        // Must not wedge: the lone `-` and `.` are stepped over.
        assert_eq!(tokens(b"- . TJ"), vec![Token::Keyword(b"TJ")]);
    }

    #[test]
    fn literal_string_escapes() {
        assert_eq!(
            strs(b"(a\\nb\\rc\\td\\be\\ff)"),
            vec![b"a\nb\rc\td\x08e\x0Cf".to_vec()]
        );
        assert_eq!(strs(b"(a\\(b\\)c\\\\d)"), vec![b"a(b)c\\d".to_vec()]);
    }

    #[test]
    fn octal_escapes_truncate_to_a_byte() {
        assert_eq!(strs(b"(\\101\\102)"), vec![b"AB".to_vec()]);
        assert_eq!(strs(b"(\\053)"), vec![b"+".to_vec()]);
        assert_eq!(strs(b"(\\400)"), vec![vec![0u8]]);
    }

    #[test]
    fn nested_parentheses_are_kept() {
        assert_eq!(strs(b"(a(b)c)"), vec![b"a(b)c".to_vec()]);
    }

    #[test]
    fn backslash_before_eol_is_a_continuation() {
        assert_eq!(strs(b"(ab\\\ncd)"), vec![b"abcd".to_vec()]);
        assert_eq!(strs(b"(ab\\\r\ncd)"), vec![b"abcd".to_vec()]);
    }

    #[test]
    fn raw_eol_inside_a_string_is_normalized_to_lf() {
        assert_eq!(strs(b"(a\r\nb\rc)"), vec![b"a\nb\nc".to_vec()]);
    }

    #[test]
    fn comments_are_skipped_between_tokens() {
        assert_eq!(
            tokens(b"1 % a comment ) with delimiters\n2"),
            vec![Token::Int(1), Token::Int(2)]
        );
    }

    #[test]
    fn comments_are_skipped_within_a_cmap_block() {
        // CMap programs routinely interleave comment lines.
        assert_eq!(
            tokens(b"beginbfchar % start\n<01> <4E2D> % CJK\nendbfchar"),
            vec![
                Token::Keyword(b"beginbfchar"),
                Token::Str(vec![0x01]),
                Token::Str(vec![0x4E, 0x2D]),
                Token::Keyword(b"endbfchar"),
            ]
        );
    }

    #[test]
    fn hex_strings_ignore_whitespace_and_pad_odd_nibbles() {
        assert_eq!(strs(b"<4E2D>"), vec![vec![0x4E, 0x2D]]);
        assert_eq!(strs(b"<4E 2\nD>"), vec![vec![0x4E, 0x2D]]);
        assert_eq!(strs(b"<4E2>"), vec![vec![0x4E, 0x20]]);
        assert_eq!(strs(b"<>"), vec![Vec::<u8>::new()]);
    }

    #[test]
    fn dict_open_is_not_a_hex_string() {
        assert_eq!(
            tokens(b"<< /A 1 >>"),
            vec![
                Token::DictOpen,
                Token::Name(Cow::Borrowed(b"A")),
                Token::Int(1),
                Token::DictClose,
            ]
        );
    }

    #[test]
    fn names_decode_hash_escapes() {
        assert_eq!(
            tokens(b"/A#20B /Plain /"),
            vec![
                Token::Name(Cow::Owned(b"A B".to_vec())),
                Token::Name(Cow::Borrowed(b"Plain".as_slice())),
                Token::Name(Cow::Borrowed(b"".as_slice())),
            ]
        );
    }

    #[test]
    fn deep_parentheses_do_not_overflow_the_stack() {
        let mut data = Vec::new();
        data.extend(std::iter::repeat(b'(').take(500));
        data.extend(std::iter::repeat(b')').take(500));
        data.extend(b" TJ");
        // The point is that this returns at all rather than aborting.
        let toks = tokens(&data);
        assert!(toks.iter().any(|t| *t == Token::Keyword(b"TJ")));
    }

    #[test]
    fn random_bytes_never_hang() {
        // A cheap deterministic PRNG keeps this test reproducible.
        let mut state: u32 = 0x1234_5678;
        let mut data = Vec::with_capacity(4096);
        for _ in 0..4096 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            data.push((state >> 16) as u8);
        }
        let mut lex = Lexer::new(&data);
        // Each iteration consumes at least one byte, so the token count is
        // bounded by the input length. A hang would show up as a test timeout.
        let mut count = 0;
        while lex.next_token().is_some() {
            count += 1;
            assert!(count <= data.len(), "lexer emitted more tokens than bytes");
        }
    }

    #[test]
    fn inline_image_payload_is_skipped() {
        // The payload deliberately contains a stray 'E' and a ')' to prove the
        // skipper does not confuse them for the terminator.
        let data = b"q BI /W 4 /H 4 ID \x01E\x02)E>\x03 EI (after) Tj";
        let mut lex = Lexer::new(data);
        let mut seen_after = false;
        let mut saw_bi = false;
        while let Some(tok) = lex.next_token() {
            match tok {
                Token::Keyword(b"BI") => {
                    saw_bi = true;
                    lex.skip_inline_image();
                }
                Token::Str(s) if s == b"after" => seen_after = true,
                _ => {}
            }
        }
        assert!(saw_bi, "BI keyword should be lexed");
        assert!(seen_after, "text after the inline image should survive");
    }
}
