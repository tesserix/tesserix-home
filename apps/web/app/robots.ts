import type { MetadataRoute } from "next";

// Every rule shares the same disallow list — non-public surfaces stay
// non-public for every crawler, not just the default one.
const DISALLOW = ["/api/", "/admin/", "/login", "/auth/"];

/**
 * AI crawler policy — an explicit decision, not a silent omission.
 *
 * DEFAULT: ALLOW. This is a marketing site whose entire purpose is
 * discoverability; being absent from AI answer engines (ChatGPT, Claude,
 * Perplexity, Google's AI features, etc.) costs more than training exposure
 * on public marketing copy. Every crawler below is named explicitly and
 * allowed on the same terms as a normal search bot, so the decision is
 * visible and trivially reversible — flip an entry to `disallow: "/"` to
 * opt a specific crawler back out.
 */
const AI_CRAWLER_USER_AGENTS = [
  "GPTBot", // OpenAI - training crawler
  "ChatGPT-User", // OpenAI - live browsing on behalf of a ChatGPT user
  "OAI-SearchBot", // OpenAI - search index crawler
  "ClaudeBot", // Anthropic - training crawler
  "Claude-User", // Anthropic - live browsing on behalf of a Claude user
  "anthropic-ai", // Anthropic - legacy crawler identifier
  "PerplexityBot", // Perplexity - search/answer engine crawler
  "Google-Extended", // Google - Gemini/AI features training signal
  "CCBot", // Common Crawl - widely used as an LLM training source
  "Applebot-Extended", // Apple - Apple Intelligence training signal
  "Bytespider", // ByteDance - training crawler
  "meta-externalagent", // Meta - AI training/search crawler
] as const;

export default function robots(): MetadataRoute.Robots {
  const baseUrl = "https://tesserix.app";

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: DISALLOW,
      },
      ...AI_CRAWLER_USER_AGENTS.map((userAgent) => ({
        userAgent,
        allow: "/",
        disallow: DISALLOW,
      })),
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
