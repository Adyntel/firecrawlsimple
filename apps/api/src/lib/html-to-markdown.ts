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
  // 1. Initial cleanup: literal newlines and carriage returns
  let rawLines = markdownContent
    .replace(/\\n/g, '\n') // Fix literal "\n" strings
    .split(/\r?\n/);

  let processedLines: string[] = [];
  
  // 2. Normalize Headers (Fixing the "----" and "====" issue)
  // We look for lines that are purely separators and convert the PREVIOUS line to a header
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    const nextLine = rawLines[i + 1] ? rawLines[i + 1].trim() : '';

    // Convert "Title \n ====" to "# Title"
    if (/^={3,}$/.test(nextLine) && line.length > 0) {
      processedLines.push(`# ${line}`);
      i++; // Skip the separator line
    }
    // Convert "Subtitle \n ----" to "## Subtitle"
    else if (/^-{3,}$/.test(nextLine) && line.length > 0) {
      processedLines.push(`## ${line}`);
      i++; // Skip the separator line
    }
    else {
      processedLines.push(rawLines[i]);
    }
  }

  // 3. Identify the "Real" Start of Content
  // We look for the first H1 (#) or H2 (##) that isn't a link
  let contentStartIndex = 0;
  for (let i = 0; i < processedLines.length; i++) {
    const line = processedLines[i].trim();
    // If we find a Header 1 or 2, this is likely the start of the article
    if (/^#{1,2}\s/.test(line)) {
      contentStartIndex = i;
      break;
    }
    // Fail-safe: If we hit a long paragraph (over 100 chars) that isn't a link, stop skipping
    if (line.length > 100 && !line.startsWith('[')) {
      contentStartIndex = i;
      break;
    }
  }

  // Slice off the navigation mess at the top
  let bodyLines = processedLines.slice(contentStartIndex);

  // 4. Filtering Logic
  const cleanedLines: string[] = [];
  let isFooter = false;

  const noisePatterns = [
    /^Open navigation menu/i,
    /^\[(Sign up|Log in|Book a call|Pricing|Documentation|Case Studies)\]/i, // Nav items
    /^!\[.+logo\]/i, // Generic logo images (usually top of page)
    /^>{1,}\s*$/, // Empty blockquotes
  ];

  // Patterns that definitely signal the start of a footer
  const footerTriggers = [
    /^\[Privacy Policy\]/i,
    /^Need more than \d+k credits/i, // Specific to your example
    /^©\s*\d{4}/,
  ];

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim();

    // STOP if we hit the footer
    if (footerTriggers.some(p => p.test(line))) {
      isFooter = true;
    }
    // Additional Footer check: High density of short links at the end
    // If we see 3 lines in a row that are just short links, and we are in the last 20% of the file
    if (!isFooter && i > bodyLines.length * 0.8) {
      if (isLinkLine(line) && isLinkLine(bodyLines[i+1] || '') && isLinkLine(bodyLines[i+2] || '')) {
        isFooter = true;
      }
    }

    if (isFooter) break;

    // Skip empty lines (we will re-add them semantically later)
    if (line === '') continue;

    // Skip specific noise
    if (noisePatterns.some(p => p.test(line))) continue;

    // Skip standalone "CTA" links (buttons) unless they are part of a list
    // e.g. [Book a call](#calendar) on its own line
    if (/^\[[^\]]+\]\([^)]+\)$/.test(line) && !line.startsWith('*') && !line.startsWith('-')) {
      // Allow it if it looks like an image link (often valuable content)
      if (!line.startsWith('[![')) {
        continue; 
      }
    }

    cleanedLines.push(bodyLines[i]); // Push the original line (preserves indentation)
  }

  // 5. Final Reassembly with clean spacing
  // We join with double newlines to ensure Markdown paragraphs render correctly,
  // then collapse excessive newlines.
  return cleanedLines
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n') // Max 2 newlines
    .trim();
  }

// Helper to detect if a line is just a markdown link
function isLinkLine(line: string): boolean {
  return /^\[.*\]\(.*\)\s*$/.test(line.trim());
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
