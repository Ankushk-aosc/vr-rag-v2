/**
 * Recognise "make me a chart" requests in typed or spoken messages (mirrors the API's
 * dashboards.is_dashboard_request / has_own_topic so both sides agree).
 */
const DASHBOARD_INTENT =
  /\b(create|make|build|show|generate|draw|plot|give|render|visuali[sz]e|display|open)\b.{0,40}\b(graphs?|charts?|dashboards?|visuals?|visuali[sz]ations?|plots?)\b/i;

const GENERIC_WORDS =
  /\b(please|can|could|you|me|a|an|the|for|of|this|that|it|create|make|build|show|generate|draw|plot|give|render|visuali[sz]e|display|open|graphs?|charts?|dashboards?|visuals?|visuali[sz]ations?|plots?|now|also|and|some|3d|vr|in)\b/gi;

export function isDashboardRequest(text: string): boolean {
  return DASHBOARD_INTENT.test(text);
}

/** "create a graph" -> false (chart the previous answer); "chart AAPL volume in 2008" -> true. */
export function hasOwnTopic(text: string): boolean {
  const rest = text.replace(GENERIC_WORDS, " ").toLowerCase();
  return (rest.match(/[a-z0-9]{3,}/g) || []).length >= 2;
}
