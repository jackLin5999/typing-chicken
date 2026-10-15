/**
 * 把真实的 KeyboardHint 组件渲染成一张 SVG —— 用来「看图」。
 *
 * 之前用手搓的假键盘做预览，结果和实际渲染对不上（少了高亮圈、键位也不完全一致），
 * 排查「哪条线遮住了哪个字母」时被误导。直接渲染真组件就不会有这个偏差。
 *
 * 用法：
 *   npx esbuild scripts/render-keyboard-hint.jsx --bundle --platform=node \
 *     --format=cjs --alias:@=./src --outfile="$TEMP/kh.cjs" && node "$TEMP/kh.cjs"
 */
import { renderToStaticMarkup } from "react-dom/server";
import { KeyboardHint } from "@/components/keyboard/KeyboardHint";

const taught = new Set("asdfjkl;".split(""));
const markup = renderToStaticMarkup(
  <KeyboardHint nextChar="f" taught={taught} showHands />,
);

// 组件外面套了一层 <div>（键盘 + 下方文字提示），只取里面的 <svg>
const start = markup.indexOf("<svg");
const end = markup.indexOf("</svg>") + "</svg>".length;
const svg = markup.slice(start, end);

if (process.argv.includes("--crop")) {
  // 裁到 f 键附近，看细节
  console.log(svg.replace(/viewBox="[^"]*"/, 'viewBox="170 70 130 130"').replace(/width="[^"]*"/, 'width="700"').replace(/height="[^"]*"/, 'height="700"'));
} else {
  console.log(svg);
}
