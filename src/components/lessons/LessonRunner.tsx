import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, Check, RotateCcw, Target, X } from "lucide-react";
import { useSettingsStore, useTypingStore } from "@/store";
import { useTypingEngine } from "@/hooks/useTypingEngine";
import { TextDisplay } from "@/components/reader/TextDisplay";
import { ReaderControls, CONTROLS_CLEARANCE } from "@/components/reader/ReaderControls";
import { KeyboardHint } from "@/components/keyboard/KeyboardHint";
import { LESSONS, LESSON_BY_ID } from "@/lib/lessons";
import type { TypingStats } from "@/types/typing";

/**
 * 上课界面。
 *
 * 刻意**不复用 ReaderPage**：那里绑了书、章节、进度自动保存、练习记录，
 * 而一节课什么都不是 —— 没有书、不该写进阅读进度、也不该记进练习历史。
 * 共用的是更下面一层：`useTypingEngine` 和 `TextDisplay`。
 */
export function LessonRunner() {
  const { lessonId } = useParams<{ lessonId: string }>();
  const navigate = useNavigate();

  const lesson = lessonId ? LESSON_BY_ID.get(lessonId) : undefined;
  const nextLesson = lesson
    ? LESSONS[LESSONS.findIndex((l) => l.id === lesson.id) + 1]
    : undefined;

  const {
    startSession,
    isActive,
    isComplete,
    cursorIndex,
    targetText,
    skipPunctuationOverride,
    setSkipPunctuationOverride,
  } = useTypingStore();
  const typingEngine = useTypingEngine();
  const showKeyboardHint = useSettingsStore((s) => s.showKeyboardHint);

  const [result, setResult] = useState<TypingStats | null>(null);
  const recordedRef = useRef(false);

  // 光标落在哪儿，就提示哪个键
  const nextChar = targetText[cursorIndex];

  /**
   * 上课时**强制不跳标点**。
   *
   * 第 5 单元教的正是标点。用户如果在阅读时开着全局的「跳过标点」，
   * 那一课会把自己要教的东西全部自动跳过 —— 等于白上。
   */
  const begin = useCallback(
    (text: string) => {
      recordedRef.current = false;
      setResult(null);
      startSession(text, { skipPunctuation: false });
    },
    [startSession],
  );

  const restart = useCallback(() => {
    if (lesson) begin(lesson.text);
  }, [lesson, begin]);

  // 换课时重开
  useEffect(() => {
    if (lesson) begin(lesson.text);
  }, [lesson, begin]);

  // 练完 → 判达标 → 记一笔
  useEffect(() => {
    if (!lesson || !isComplete || recordedRef.current) return;

    const snapshot = useTypingStore.getState().stats;
    if (snapshot.totalKeystrokes === 0) return; // 一个字没打不算完成

    recordedRef.current = true;
    setResult(snapshot);

    const passed =
      snapshot.accuracy >= lesson.targetAccuracy &&
      (lesson.targetWpm === 0 || snapshot.wpm >= lesson.targetWpm);

    invoke("record_lesson_result", {
      lessonId: lesson.id,
      accuracy: snapshot.accuracy,
      wpm: snapshot.wpm,
      passed,
    }).catch((err) => console.error("记录课程成绩失败:", err));
  }, [isComplete, lesson]);

  if (!lesson) {
    return (
      <div className="h-full bg-paper flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-muted text-sm">没有这节课</p>
          <button
            onClick={() => navigate("/lessons")}
            className="text-sm text-accent hover:underline cursor-pointer"
          >
            返回课程列表
          </button>
        </div>
      </div>
    );
  }

  const progressPct =
    targetText.length > 0 ? Math.round((cursorIndex / targetText.length) * 100) : 0;

  // 按 ESC 会结束会话（isActive 变 false）。没有这一屏的话，
  // 界面会变成一个「看着正常但敲什么都没反应」的死页面 —— 阅读界面早就补了这一手。
  if (!isActive && !isComplete) {
    return (
      <div className="h-full bg-paper flex items-center justify-center">
        <div className="text-center space-y-4 animate-fade-in">
          <p className="text-muted text-sm">这一课已结束</p>
          <div className="flex items-center gap-3 justify-center">
            <button
              onClick={restart}
              className="px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent/90 transition-colors cursor-pointer"
            >
              重新开始
            </button>
            <button
              onClick={() => navigate("/lessons")}
              className="text-sm text-muted hover:text-ink transition-colors cursor-pointer"
            >
              返回课程列表
            </button>
          </div>
        </div>
      </div>
    );
  }

  const passed =
    result !== null &&
    result.accuracy >= lesson.targetAccuracy &&
    (lesson.targetWpm === 0 || result.wpm >= lesson.targetWpm);

  return (
    <div className="h-full bg-paper flex flex-col">
      {/* 进度条 */}
      <div className="h-[3px] bg-surface-hover shrink-0">
        <div
          className="h-full bg-accent transition-[width] duration-300 ease-out rounded-r-sm"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* 课程头 */}
      <header className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-gray-200/50 dark:border-gray-700/30">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-muted">
            {lesson.unitTitle} · 第 {lesson.index} 课
          </p>
          <h1 className="text-sm font-semibold text-ink truncate">{lesson.title}</h1>
        </div>

        {/* 达标线 —— 让用户知道「什么算过」 */}
        <div className="shrink-0 text-right">
          <p className="text-[10px] text-muted">达标</p>
          <p className="text-[11px] font-medium text-ink tabular-nums">
            准确 ≥{lesson.targetAccuracy}%
            {lesson.targetWpm > 0 && ` · 速度 ≥${lesson.targetWpm}`}
          </p>
        </div>
      </header>

      {/* 打字区 —— 底部让位是给下方那条浮动工具栏的，否则最后一行会被它盖住。
          但键盘提示在流内、并且自己已经让过位，这时就不必再留一遍。 */}
      <div
        className={`flex-1 overflow-y-auto ${showKeyboardHint ? "pb-4" : CONTROLS_CLEARANCE}`}
        data-scroll-container
      >
        <TextDisplay
          inputRef={typingEngine.inputRef}
          onInput={typingEngine.handleInput}
          onCompositionStart={typingEngine.handleCompositionStart}
          onCompositionUpdate={typingEngine.handleCompositionUpdate}
          onCompositionEnd={typingEngine.handleCompositionEnd}
          onBlur={typingEngine.handleBlur}
          onKeyDown={typingEngine.handleKeydown}
        />
      </div>

      {/* 指法提示 —— 贴在打字区正下方，视线不用来回跑。
          CONTROLS_CLEARANCE 把它整体抬到浮动工具栏之上 —— 不带这一步，
          手掌和下方那行提示文字会被工具栏压住。 */}
      {showKeyboardHint && (
        <div
          className={`shrink-0 max-w-2xl w-full mx-auto px-4 ${CONTROLS_CLEARANCE}`}
        >
          <KeyboardHint nextChar={nextChar} taught={lesson.allowed} showHands />
        </div>
      )}

      {/* 工具栏 —— 和阅读界面共用同一条，只是不传章节那一组 */}
      <ReaderControls
        onBack={() => navigate("/lessons")}
        onRestart={restart}
        punctuation={{
          // 课程默认关（标点课不能被跳过），但用户随时可以打开。
          // 改的是**本次会话的覆盖值**，不动阅读时的全局开关。
          value: skipPunctuationOverride ?? false,
          onChange: setSkipPunctuationOverride,
        }}
      />

      {/* 结算 */}
      {result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-2xl animate-slide-up overflow-hidden">
            <div className="flex flex-col items-center gap-2 pt-8 pb-4 bg-gradient-to-b from-accent/10 to-transparent">
              <div
                className={`w-14 h-14 rounded-full flex items-center justify-center ${
                  passed ? "bg-accent-correct/20" : "bg-accent/20"
                }`}
              >
                {passed ? (
                  <Check size={28} className="text-accent-correct" />
                ) : (
                  <Target size={28} className="text-accent" />
                )}
              </div>
              <h2 className="text-lg font-bold text-ink font-serif">
                {passed ? "这一课通过了" : "再练一遍会更稳"}
              </h2>
              <p className="text-xs text-muted">
                {passed
                  ? "手指已经开始记住位置了"
                  : `达标线：准确 ≥${lesson.targetAccuracy}%${lesson.targetWpm > 0 ? ` · 速度 ≥${lesson.targetWpm}` : ""}`}
              </p>
            </div>

            <div className="px-6 py-4 grid grid-cols-2 gap-3">
              <Stat label="准确率" value={`${result.accuracy}%`} good={result.accuracy >= lesson.targetAccuracy} />
              <Stat label="速度" value={`${result.wpm}`} good={lesson.targetWpm === 0 || result.wpm >= lesson.targetWpm} />
              <Stat label="用时" value={`${result.elapsedSeconds} 秒`} />
              <Stat label="击键" value={`${result.correctKeystrokes} / ${result.totalKeystrokes}`} />
            </div>

            <div className="px-6 pb-6 pt-2 flex flex-col gap-2">
              {nextLesson && passed && (
                <button
                  onClick={() => navigate(`/lessons/${nextLesson.id}`)}
                  className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-accent text-white text-sm font-semibold hover:bg-blue-600 active:bg-blue-700 transition-colors shadow-sm cursor-pointer"
                >
                  <ArrowRight size={16} />
                  下一课：{nextLesson.title}
                </button>
              )}
              <div className="flex gap-2">
                <button
                  onClick={restart}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-surface-alt text-ink text-sm font-medium hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  <RotateCcw size={14} />
                  再练一遍
                </button>
                <button
                  onClick={() => navigate("/lessons")}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-surface-alt text-ink text-sm font-medium hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  <X size={14} />
                  课程列表
                </button>
              </div>
              {/* 没达标也允许往下走 —— 卡关是打字软件最大的劝退点 */}
              {nextLesson && !passed && (
                <button
                  onClick={() => navigate(`/lessons/${nextLesson.id}`)}
                  className="w-full py-1.5 rounded-lg text-xs text-muted hover:text-ink transition-colors cursor-pointer"
                >
                  先跳过，去下一课 →
                </button>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-0.5 p-3 rounded-xl bg-surface-alt">
      <span className="text-[10px] tracking-[0.15em] text-muted font-medium">{label}</span>
      <span
        className={`text-xl font-bold tabular-nums ${
          good === undefined ? "text-ink" : good ? "text-accent-correct" : "text-error"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
