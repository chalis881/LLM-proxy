/**
 * 稳定 JSON 序列化 —— 深度按 key 字典序排列
 *
 * 为什么需要：
 *   客户端发的 JSON key 顺序可能每次不同
 *   （如 {"role":"user","content":"hi"} vs {"content":"hi","role":"user"}）
 *   语义完全相同，但字节表示不同 → 破坏上游厂商 prefix cache
 *
 *   厂商 prefix cache 基于 messages 序列化后的字节做前缀匹配，
 *   key 顺序不稳定会导致相同语义的 prompt 每次字节不同 → 缓存失效
 *
 * 原理：
 *   递归遍历所有对象，按 key 字典序排列后序列化
 *   不修改任何值，只调整 key 输出顺序
 *   数组顺序保持不变（messages 数组的顺序是语义性的）
 *
 * 适用场景：所有 cacheMode（none/active/implicit），零内容破坏
 */

/**
 * 对象 key 字典序深度排序后 JSON 序列化
 * 不修改任何 value，只让字节表示确定（相同语义 → 相同字节）
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * 递归排序对象 key（返回新对象，不改原值）
 * 数组顺序保持不变
 */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    // 数组：顺序是语义性的（messages 顺序不能动），只递归排序每个元素
    return value.map(sortKeysDeep) as unknown as T;
  }
  if (value && typeof value === "object") {
    // 对象：收集 key → 排序 → 按序构建新对象
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = sortKeysDeep(obj[key]);
    }
    return result as unknown as T;
  }
  if (typeof value === "string") {
    return value.normalize("NFC") as unknown as T;
  }
  if (typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)) {
    return Number(value.toFixed(6)) as unknown as T;
  }
  // 原始类型：原样返回
  return value;
}
