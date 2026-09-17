import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type KeybindingsManager,
  fuzzyMatch,
  matchesKey,
} from "@earendil-works/pi-tui";

const USER_ALIASES_PATH = join(homedir(), ".pi/agent/pi-zh-slash.aliases.json");

/**
 * 命令名 → 中文别名（首个为主名，显示为「中文（英文）」）。
 * 用户文件 `~/.pi/agent/pi-zh-slash.aliases.json` 只做追加，不覆盖这里的默认值。
 * skill 命令刻意不列，保持英文原样。
 */
export const DEFAULT_ALIASES: Record<string, string[]> = {
  // —— pi 内置命令 ——
  settings: ["设置"],
  model: ["模型"],
  tree: ["会话树", "树"],
  thinking: ["思考"],
  "scoped-models": ["模型范围"],
  export: ["导出"],
  import: ["导入"],
  share: ["分享"],
  copy: ["复制"],
  name: ["命名"],
  session: ["会话"],
  changelog: ["更新日志"],
  hotkeys: ["快捷键", "热键"],
  fork: ["分叉"],
  clone: ["克隆"],
  trust: ["信任"],
  login: ["登录"],
  logout: ["登出"],
  new: ["新会话", "新建"],
  compact: ["压缩"],
  resume: ["恢复"],
  reload: ["重载", "刷新"],
  quit: ["退出"],
  // —— 常见社区扩展（未安装时不会出现在补全里） ——
  clear: ["清空", "清除"],
  exit: ["退出程序", "结束"],
  outline: ["大纲"],
  usage: ["用量", "额度", "余额"],
};

type AliasMap = Map<string, string[]>;

function loadAliasMap(): AliasMap {
  const map: AliasMap = new Map();
  for (const [name, aliases] of Object.entries(DEFAULT_ALIASES)) {
    map.set(name, [...aliases]);
  }
  try {
    const extra = JSON.parse(readFileSync(USER_ALIASES_PATH, "utf8")) as unknown;
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) return map;
    for (const [name, aliases] of Object.entries(extra as Record<string, unknown>)) {
      if (!Array.isArray(aliases)) continue;
      const merged = map.get(name) ?? [];
      for (const alias of aliases) {
        if (typeof alias === "string" && alias && !merged.includes(alias)) merged.push(alias);
      }
      map.set(name, merged);
    }
  } catch {
    // 没有用户文件或 JSON 无效时，只用默认表。
  }
  return map;
}

const DUNHAO = "、";
/** 顿号命令 token：`、` 开头，不含空白、`/` 与第二个顿号。 */
const TOKEN_RE = /^\u3001[^\s/\u3001]*$/u;

/** 第一行、光标前是「、命令」。 */
function isDunhaoCommand(lines: string[], line: number, col: number): boolean {
  return line === 0 && TOKEN_RE.test((lines[0] ?? "").slice(0, col));
}

/**
 * 匹配档位：越靠前越优先。
 * 同一档位内先用别名覆盖度、再用模糊分分先后：
 * 「命名」命中率 2/2 胜过「自动命名」的 2/4，所以 `、名` 稳定解析到 /name。
 */
const TIER = {
  nameExact: 0,
  aliasExact: 1,
  namePrefix: 2,
  aliasPrefix: 3,
  nameIncludes: 4,
  aliasIncludes: 5,
  nameFuzzy: 6,
  aliasFuzzy: 7,
} as const;

const TIER_SPAN = 1_000_000;

/** 别名里被 query 覆盖的比例（0~1），用于同档位内排序。 */
function coverage(query: string, text: string): number {
  if (!text) return 0;
  return [...query].length / [...text].length;
}

/** 全量打分：列表排序与「、」解析共用，保证所见即所得。 */
export function scoreCommand(query: string, name: string, aliases: string[]): number | undefined {
  if (!query) return 0;
  let bestTier = Number.POSITIVE_INFINITY;
  let bestCoverage = 0;
  let bestFuzzy = 0;
  const consider = (tier: number, fuzzyScore: number, cover: number) => {
    if (
      tier < bestTier ||
      (tier === bestTier && (cover > bestCoverage || (cover === bestCoverage && fuzzyScore < bestFuzzy)))
    ) {
      bestTier = tier;
      bestFuzzy = fuzzyScore;
      bestCoverage = cover;
    }
  };

  const lowered = name.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const nameFuzzy = fuzzyMatch(query, name);
  const nameScore = nameFuzzy.matches ? nameFuzzy.score : 0;
  if (lowered === loweredQuery) consider(TIER.nameExact, nameScore, 1);
  else if (lowered.startsWith(loweredQuery)) consider(TIER.namePrefix, nameScore, coverage(query, lowered));
  else if (lowered.includes(loweredQuery)) consider(TIER.nameIncludes, nameScore, coverage(query, lowered));
  else if (nameFuzzy.matches) consider(TIER.nameFuzzy, nameScore, coverage(query, lowered));

  for (const alias of aliases) {
    const aliasFuzzy = fuzzyMatch(query, alias);
    const aliasScore = aliasFuzzy.matches ? aliasFuzzy.score : 0;
    const cover = coverage(query, alias);
    if (alias === query) consider(TIER.aliasExact, aliasScore, 1);
    else if (alias.startsWith(query)) consider(TIER.aliasPrefix, aliasScore, cover);
    else if (alias.includes(query)) consider(TIER.aliasIncludes, aliasScore, cover);
    else if (aliasFuzzy.matches) consider(TIER.aliasFuzzy, aliasScore, cover);
  }

  if (bestTier === Number.POSITIVE_INFINITY) return undefined;
  // 主序：档位 → 覆盖度（越大越好）→ 模糊分。
  const coverPenalty = Math.round((1 - bestCoverage) * (TIER_SPAN / 2));
  const fuzzyTiebreak = Math.max(0, Math.min(1000, Math.round(bestFuzzy + 5000)));
  return bestTier * TIER_SPAN + coverPenalty * 1000 + fuzzyTiebreak;
}

/**
 * 按分数取唯一命令；并列时返回 undefined，由用户继续敲或从列表里挑。
 * 空 query（如刚敲完「、」）不算歧义。
 */
function pickUnique(entries: Array<{ name: string; score: number }>): string | undefined {
  if (entries.length === 0) return undefined;
  const sorted = [...entries].sort((a, b) => a.score - b.score);
  const first = sorted[0]!;
  const second = sorted[1];
  if (second && second.score === first.score) return undefined;
  return first.name;
}

/**
 * 把「、名」解析为英文命令名。
 * 英文名（含扩展/skill 命令）与中文别名同等对待，全量对比后取唯一最优。
 */
export function resolveToken(token: string, aliases: AliasMap, extraNames: Iterable<string>): string | undefined {
  if (!token) return undefined;
  const names = new Set<string>([...aliases.keys(), ...extraNames]);
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of names) {
    const score = scoreCommand(token, name, aliases.get(name) ?? []);
    if (score !== undefined) scored.push({ name, score });
  }
  return pickUnique(scored);
}

function decorate(item: AutocompleteItem, aliases: string[]): AutocompleteItem {
  const primary = aliases[0];
  if (!primary) return item;
  return { ...item, label: `${primary}（${item.value}）` };
}

function filterCatalog(items: AutocompleteItem[], query: string, aliases: AliasMap): AutocompleteItem[] {
  const ranked = items
    .map((item) => {
      const names = aliases.get(item.value) ?? [];
      const score = scoreCommand(query, item.value, names);
      return score === undefined ? undefined : { item: decorate(item, names), score };
    })
    .filter((row): row is { item: AutocompleteItem; score: number } => row !== undefined)
    .sort((a, b) => a.score - b.score);
  return ranked.map((row) => row.item);
}

/**
 * 整段文本的兜底重写：`、名 参数` → `/name 参数`。
 * 只处理单行且以「、」开头的输入；已经用 `/` 的输入原样放过。
 */
export function rewriteWholeInput(text: string, aliases: AliasMap, extraNames: Iterable<string>): string | undefined {
  if (text.includes("\n") || !text.startsWith(DUNHAO)) return undefined;
  const match = /^(\u3001[^\s/\u3001]*)([\s\S]*)$/u.exec(text);
  if (!match) return undefined;
  const resolved = resolveToken((match[1] ?? "").slice(1), aliases, extraNames);
  if (!resolved) return undefined;
  return `/${resolved}${match[2] ?? ""}`;
}

/** 光标处是否刚好停在一个「、命令」token 末尾（不跨行）。 */
function pendingToken(text: string, line: number, col: number): string | undefined {
  if (line !== 0) return undefined;
  const first = text.split("\n")[0] ?? "";
  if (col !== first.length) return undefined;
  const token = first.slice(0, col);
  return TOKEN_RE.test(token) && token.length > 1 ? token : undefined;
}

export function withChineseSlash(current: AutocompleteProvider, aliases: AliasMap): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), DUNHAO])],
    async getSuggestions(lines, line, col, options) {
      if (!isDunhaoCommand(lines, line, col)) {
        return current.getSuggestions(lines, line, col, options);
      }
      const catalog = await current.getSuggestions(["/"], 0, 1, { ...options, force: false });
      if (!catalog?.items?.length) return null;
      const query = (lines[0] ?? "").slice(1, col);
      const items = filterCatalog(catalog.items, query, aliases);
      if (items.length === 0) return null;
      // prefix 用「/」开头、长度与「、」token 一致：
      // 1) 底层 applyCompletion 能按 slash 命令定位插入点；
      // 2) 列表回车后底层会 fall through 到提交，与原生 /命令 一致。
      return { items, prefix: `/${query}` } satisfies AutocompleteSuggestions;
    },
    applyCompletion(lines, line, col, item, prefix) {
      if (!isDunhaoCommand(lines, line, col)) {
        return current.applyCompletion(lines, line, col, item, prefix);
      }
      // 首行的「、」等长换成「/」，其余内容与光标位置不变，交给底层按 / 命令插入。
      const rewritten = `/${(lines[0] ?? "").slice(1)}`;
      const slashPrefix = prefix.startsWith(DUNHAO) ? `/${prefix.slice(1)}` : prefix;
      return current.applyCompletion([rewritten, ...lines.slice(1)], line, col, item, slashPrefix);
    },
    shouldTriggerFileCompletion(lines, line, col) {
      if (isDunhaoCommand(lines, line, col)) return true;
      return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
    },
  };
}

/**
 * 编辑器子类，补上「、」与原生 `/` 之间的三处缺口：
 *
 * 1. 空格定形：`、名` + 空格 → 立刻变 `/name `，此后与原生完全一致，
 *    参数候选（如 `/model ` 的模型列表）照常由底层给出。
 * 2. IME 一次性上屏：`、设置` 整块落进编辑器时底层不会触发补全，这里补一次。
 * 3. 回车兜底：列表未开而直接回车时，把 `、名 参数` 重写为 `/name 参数`。
 */
class ChineseSlashEditor extends CustomEditor {
  private readonly kb: KeybindingsManager;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    kb: KeybindingsManager,
    private readonly cfg: { aliases: AliasMap; extraNames: Iterable<string> },
  ) {
    super(tui, theme, kb, { embedWorkingStatus: true });
    this.kb = kb;
  }

  private isSubmitKey(data: string): boolean {
    return this.kb.matches(data, "tui.input.submit") || matchesKey(data, "enter");
  }

  private isSpaceKey(data: string): boolean {
    return data === " " || matchesKey(data, "space") || matchesKey(data, "shift+space");
  }

  /**
   * 补一次补全请求。
   * 方法名刻意避开 Editor 的私有方法名（编译后是普通属性，重名会自我递归）。
   */
  private kickSuggestions(): void {
    const self = this as unknown as { tryTriggerAutocomplete?: (explicitTab?: boolean) => void };
    self.tryTriggerAutocomplete?.();
  }

  /** 列表开着且高亮项与「、token」解析结果不一致时，让空格保持原生语义。 */
  private selectionConflicts(resolved: string): boolean {
    if (!this.isShowingAutocomplete()) return false;
    const selected = this.autocompleteList?.getSelectedItem();
    return selected !== null && selected !== undefined && selected.value !== resolved;
  }

  override handleInput(data: string): void {
    const text = this.getText();
    const { line, col } = this.getCursor();
    const token = pendingToken(text, line, col);
    // 仅当整块内容就是一个「、命令」时才定形，避免吞掉后面的正文。
    const resolved =
      token !== undefined && text === token
        ? resolveToken(token.slice(1), this.cfg.aliases, this.cfg.extraNames)
        : undefined;

    let reshaped = false;
    if (resolved && this.isSpaceKey(data) && !this.selectionConflicts(resolved)) {
      // 空格定形：`、名` → `/name`，随后由底层插入空格并给出参数候选。
      this.setText(`/${resolved}`);
      reshaped = true;
    } else if (this.isSubmitKey(data) && !this.isShowingAutocomplete()) {
      const next = rewriteWholeInput(text, this.cfg.aliases, this.cfg.extraNames);
      if (next !== undefined) this.setText(next);
    }

    super.handleInput(data);

    if (reshaped) {
      this.kickSuggestions();
      return;
    }
    // IME 一次性上屏的「、命令」（不逐字触发），补一次补全。
    if (!this.isShowingAutocomplete() && data.length > 1 && !data.includes("\x1b") && data.startsWith(DUNHAO)) {
      const cursor = this.getCursor();
      if (pendingToken(this.getText(), cursor.line, cursor.col) !== undefined) this.kickSuggestions();
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const aliases = loadAliasMap();
    const extraNames = pi.getCommands().map((command) => command.name);
    ctx.ui.addAutocompleteProvider((current) => withChineseSlash(current, aliases));
    if (!ctx.ui.getEditorComponent()) {
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) => new ChineseSlashEditor(tui, theme, keybindings, { aliases, extraNames }),
      );
    }
  });
}
