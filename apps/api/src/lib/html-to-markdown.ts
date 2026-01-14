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
  // ---------------------------------------------------------
  // 1. THE NUCLEAR FIX FOR \n
  // ---------------------------------------------------------
  // This aggressively replaces literal "\\n" (two chars) with actual newline
  // We do this BEFORE splitting so the structure is correct.
  let cleanInput = markdownContent
    .replace(/\\n/g, '\n')   // Convert literal \n to real newline
    .replace(/\\r/g, '')     // Remove literal \r
    .replace(/\r\n/g, '\n')  // Normalize Windows line endings
    .replace(/\r/g, '\n');   // Normalize old Mac line endings

  // Split into lines based on REAL newlines now
  let rawLines = cleanInput.split('\n');
  let processedLines: string[] = [];

  // ---------------------------------------------------------
  // 2. Structure Normalization (Headers)
  // ---------------------------------------------------------
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    const nextLine = rawLines[i + 1] ? rawLines[i + 1].trim() : '';

    // Convert Setext headers (====, ----) to ATX headers (#, ##)
    if (/^={3,}$/.test(nextLine) && line.length > 0) {
      processedLines.push(`# ${line}`);
      i++; 
    } else if (/^-{3,}$/.test(nextLine) && line.length > 0) {
      processedLines.push(`## ${line}`);
      i++; 
    } else {
      processedLines.push(rawLines[i]); // Keep indentation
    }
  }

  // ---------------------------------------------------------
  // 3. Find Main Content (Skip Nav)
  // ---------------------------------------------------------
  let contentStartIndex = 0;
  for (let i = 0; i < processedLines.length; i++) {
    const line = processedLines[i].trim();
    // Look for first Header 1 or 2, OR a long text block that isn't a link
    if (/^#{1,2}\s/.test(line) || (line.length > 80 && !line.startsWith('['))) {
      contentStartIndex = i;
      break;
    }
  }

  let bodyLines = processedLines.slice(contentStartIndex);
  const cleanedLines: string[] = [];
  
  // ---------------------------------------------------------
  // 4. Content Filtering (Remove Footer/Noise)
  // ---------------------------------------------------------
  const noisePatterns = [
    /^Open navigation menu/i,
    /^\[(Sign up|Log in|Book a call|Pricing|Documentation|Case Studies)\]/i,
    /^!\[.+logo\]/i,
    /^>{1,}\s*$/, // Empty quotes
  ];

  const footerTriggers = [
    /^\[Privacy Policy\]/i,
    /^Need more than \d+k credits/i,
    /^©\s*\d{4}/,
  ];

  let isFooter = false;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim();

    // Check for footer start
    if (footerTriggers.some(p => p.test(line))) isFooter = true;
    
    // Heuristic: If last 20% of doc and we see 3 consecutive lines of just links -> Footer
    if (!isFooter && i > bodyLines.length * 0.8) {
      if (isLinkLine(line) && isLinkLine(bodyLines[i+1] || '') && isLinkLine(bodyLines[i+2] || '')) {
        isFooter = true;
      }
    }

    if (isFooter) break;
    if (noisePatterns.some(p => p.test(line))) continue;

    // Skip standalone CTA links unless they look like content images
    if (/^\[[^\]]+\]\([^)]+\)$/.test(line) && !line.startsWith('![') && !line.startsWith('*')) {
      continue; 
    }

    cleanedLines.push(line);
  }

  // ---------------------------------------------------------
  // 5. Final Assembly (The Clean Up)
  // ---------------------------------------------------------
  
  // Join with actual newlines
  let result = cleanedLines.join('\n');

  // Final Cleanup Regex:
  // 1. Replace 3+ newlines with 2 (max one empty line between paragraphs)
  // 2. Ensure NO literal "\n" strings survived
  return result
    .replace(/\n{3,}/g, '\n\n') 
    .replace(/\\n/g, '\n') // One last check for stragglers
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
