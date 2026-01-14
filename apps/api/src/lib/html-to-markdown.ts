import koffi from "koffi";
import { join } from "path";
import dotenv from "dotenv";
import { Logger } from "./logger";
dotenv.config();

class GoMarkdownConverter {
  private static instance: GoMarkdownConverter;
  private convert: any;

  private constructor() {
    const goExecutablePath = join(
      __dirname,
      "go-html-to-md/html-to-markdown.so"
    );
    const lib = koffi.load(goExecutablePath);
    this.convert = lib.func("ConvertHTMLToMarkdown", "string", ["string"]);
  }

  public static getInstance(): GoMarkdownConverter {
    if (!GoMarkdownConverter.instance) {
      GoMarkdownConverter.instance = new GoMarkdownConverter();
    }
    return GoMarkdownConverter.instance;
  }

  public async convertHTMLToMarkdown(html: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.convert.async(html, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }
}

export async function parseMarkdown(html: string): Promise<string> {
  if (!html) {
    return "";
  }

  try {
    if (process.env.USE_GO_MARKDOWN_PARSER == "true") {
      const converter = GoMarkdownConverter.getInstance();
      let markdownContent = await converter.convertHTMLToMarkdown(html);

      markdownContent = processMultiLineLinks(markdownContent);
      markdownContent = removeSkipToContentLinks(markdownContent);
      markdownContent = cleanMarkdownContent(markdownContent);
      Logger.info(`HTML to Markdown conversion using Go parser successful`);
      return markdownContent;
    }
  } catch (error) {
    Logger.error(`Error converting HTML to Markdown with Go parser: ${error}`);
  }

  // Fallback to TurndownService if Go parser fails or is not enabled
  var TurndownService = require("turndown");
  var turndownPluginGfm = require("joplin-turndown-plugin-gfm");

  const turndownService = new TurndownService();
  turndownService.addRule("inlineLink", {
    filter: function (node, options) {
      return (
        options.linkStyle === "inlined" &&
        node.nodeName === "A" &&
        node.getAttribute("href")
      );
    },
    replacement: function (content, node) {
      var href = node.getAttribute("href").trim();
      var title = node.title ? ' "' + node.title + '"' : "";
      return "[" + content.trim() + "](" + href + title + ")\n";
    },
  });
  var gfm = turndownPluginGfm.gfm;
  turndownService.use(gfm);

  try {
    let markdownContent = await turndownService.turndown(html);
    markdownContent = processMultiLineLinks(markdownContent);
    markdownContent = removeSkipToContentLinks(markdownContent);
    markdownContent = cleanMarkdownContent(markdownContent);

    return markdownContent;
  } catch (error) {
    console.error("Error converting HTML to Markdown: ", error);
    return ""; // Optionally return an empty string or handle the error as needed
  }
}

function processMultiLineLinks(markdownContent: string): string {
  let insideLinkContent = false;
  let newMarkdownContent = "";
  let linkOpenCount = 0;
  for (let i = 0; i < markdownContent.length; i++) {
    const char = markdownContent[i];

    if (char == "[") {
      linkOpenCount++;
    } else if (char == "]") {
      linkOpenCount = Math.max(0, linkOpenCount - 1);
    }
    insideLinkContent = linkOpenCount > 0;

    if (insideLinkContent && char == "\n") {
      newMarkdownContent += "\\" + "\n";
    } else {
      newMarkdownContent += char;
    }
  }
  return newMarkdownContent;
}

function removeSkipToContentLinks(markdownContent: string): string {
  // Remove [Skip to Content](#page) and [Skip to content](#skip)
  const newMarkdownContent = markdownContent.replace(
    /\[Skip to Content\]\(#[^\)]*\)/gi,
    ""
  );
  return newMarkdownContent;
}

function cleanMarkdownContent(markdownContent: string): string {
  let lines = markdownContent.split('\n');
  let cleanedLines: string[] = [];

  // First pass: identify and remove header navigation (before main content)
  let mainContentIndex = -1;

  // Find where main content starts (first real heading with substantial text)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Main content typically starts with an h1 that has descriptive text (more than 3 words)
    if (/^#{1,2}\s+.+/.test(line)) {
      const headingText = line.replace(/^#+\s*/, '');
      const wordCount = headingText.split(/\s+/).length;
      // Skip single-word or very short headings that are likely navigation
      if (wordCount >= 3 && !isNavigationHeading(headingText)) {
        mainContentIndex = i;
        break;
      }
    }
  }

  // If we found main content, skip everything before it
  const startIndex = mainContentIndex > 0 ? mainContentIndex : 0;

  // Patterns for lines that should always be removed
  const removePatterns = [
    // Navigation anchors
    /^\[Navigation\]\(#\)/i,
    /^\[Skip to \w+\]/i,
    /^\[Menu\]\(#\)/i,

    // Empty link brackets or single-word nav links at line start
    /^\[\w{1,15}\]\(#\)$/,  // [Word](#) - hash-only links

    // JavaScript void links
    /javascript:void\(0\)/i,

    // Social media icon links (empty text)
    /^\[\]\(https?:\/\/(www\.)?(facebook|twitter|x\.com|instagram|linkedin|youtube|bsky\.app|github\.com)/i,

    // Cookie/privacy notices
    /^(We use cookies|This site uses cookies|Accept all cookies|Cookie settings)/i,

    // Email signup prompts
    /^(Updates about .+, discounts|Free email course|Subscribe to our|Sign up for our|Enter your email)/i,
    /^I have read and accept the/i,

    // Generic promotional/modal text
    /^(Your trial is downloading|Thank you for subscribing|Want to win|Try .+ for Free)/i,
    /^Please check your email/i,
    /^Close$/,
  ];

  // Patterns for footer-like link lists (typically short navigational links)
  const footerLinkPatterns = [
    /^\*\s*\[(Releases|Developers|Designers|Teams|Enterprise|Students|Teachers|Universities)\]/i,
    /^\*\s*\[(About|Press|Jobs|Careers|Contact|Blog|Help|FAQ)\]/i,
    /^\*\s*\[(Privacy Policy|Terms|License|Legal|Imprint|Impressum)\]/i,
    /^\*\s*\[(Download for|Get Started|Sign Up|Log In|Register)\]/i,
    /^\*\s*\[(Code Diff|\.gitignore|Free Tools)\]/i,
  ];

  // Patterns for standalone CTA buttons (links on their own line)
  const ctaPatterns = [
    /^\[(Download|Get Started|Try|Start|Sign Up|Learn More|Read More|Explore|View|See)\s/i,
    /^\[Also available for/i,
  ];

  let inFooterSection = false;
  let footerLinkCount = 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    const originalLine = lines[i];

    // Skip empty lines at the very start
    if (cleanedLines.length === 0 && line === '') {
      continue;
    }

    // Check if line matches removal patterns
    if (removePatterns.some(pattern => pattern.test(line))) {
      continue;
    }

    // Detect footer section by consecutive footer-like links
    if (footerLinkPatterns.some(pattern => pattern.test(line))) {
      footerLinkCount++;
      if (footerLinkCount >= 2) {
        inFooterSection = true;
      }
      continue;
    }

    // Reset footer detection if we hit non-footer content
    if (line !== '' && !footerLinkPatterns.some(pattern => pattern.test(line))) {
      // But if we're deep in footer, keep skipping
      if (inFooterSection) {
        // Check if this looks like footer content (short link lists, copyright, etc.)
        if (/^\*\s*\[.{1,30}\]\(/.test(line) || /^©/.test(line) || line === '') {
          continue;
        }
        // Real content might reset footer mode
        if (/^#{1,3}\s+.{20,}/.test(line)) {
          inFooterSection = false;
          footerLinkCount = 0;
        } else {
          continue;
        }
      } else {
        footerLinkCount = 0;
      }
    }

    // Skip standalone CTA links (but keep them if part of a paragraph)
    if (ctaPatterns.some(pattern => pattern.test(line))) {
      // Check if previous line was empty or this is isolated
      const prevLine = cleanedLines.length > 0 ? cleanedLines[cleanedLines.length - 1].trim() : '';
      if (prevLine === '' || /^\[.+\]\(.+\)$/.test(line)) {
        continue;
      }
    }

    // Skip copyright lines
    if (/^©\s*\d{4}/.test(line)) {
      continue;
    }

    // Skip lines that are just a single short link (likely navigation)
    if (/^\[.{1,20}\]\([^)]+\)$/.test(line) && cleanedLines.length < 3) {
      continue;
    }

    cleanedLines.push(originalLine);
  }

  // Remove trailing empty lines
  while (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1].trim() === '') {
    cleanedLines.pop();
  }

  // Remove excessive consecutive empty lines (more than 2)
  let result: string[] = [];
  let consecutiveEmpty = 0;
  for (const line of cleanedLines) {
    if (line.trim() === '') {
      consecutiveEmpty++;
      if (consecutiveEmpty <= 2) {
        result.push(line);
      }
    } else {
      consecutiveEmpty = 0;
      result.push(line);
    }
  }

  let finalResult = result.join('\n');

  // Replace literal \n with actual newlines
  finalResult = finalResult.replace(/\\n/g, '\n');

  return finalResult;
}

function isNavigationHeading(text: string): boolean {
  const navHeadings = [
    /^navigation$/i,
    /^menu$/i,
    /^main menu$/i,
    /^site navigation$/i,
    /^footer$/i,
    /^header$/i,
  ];
  return navHeadings.some(pattern => pattern.test(text.trim()));
}
