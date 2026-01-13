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
  let inNavigation = false;
  let inFooter = false;
  let inModal = false;

  // Patterns to identify sections to remove
  const navigationPatterns = [
    /^#+\s*Navigation/i,
    /^\*\s*\[Features\]/i,
    /^\*\s*\[Pricing\]/i,
    /^\*\s*\[Support\]/i,
    /^\*\s*\[Learn\s+\w+\]/i,
    /^\*\s*\[Blog\]/i,
    /^\*\s*\[Download\]/i,
  ];

  const footerPatterns = [
    /^#+\s*(Tower Git Client|Use Cases|Features|Free Tools|Support|Company|Legal)/i,
    /^\*\s*\[Download for/i,
    /^\*\s*\[About\]/i,
    /^\*\s*\[Press\]/i,
    /^\*\s*\[Jobs\]/i,
    /^\*\s*\[Privacy Policy\]/i,
    /^\*\s*\[License Agreement\]/i,
    /^©\s*\d{4}/i,
  ];

  const modalPatterns = [
    /^(Your trial is downloading|Updates, Courses & Content via Email|Thank you for subscribing|Want to win|Try Tower for Free)/i,
    /^I have read and accept the/i,
    /^Please check your email/i,
    /^Close$/i,
  ];

  // Track main content start
  let mainContentStarted = false;
  let emptyLineCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines at the start
    if (!mainContentStarted && line === '') {
      continue;
    }

    // Check if we're entering a navigation section
    if (navigationPatterns.some(pattern => pattern.test(line))) {
      inNavigation = true;
      continue;
    }

    // Check if we're entering a footer section
    if (footerPatterns.some(pattern => pattern.test(line))) {
      inFooter = true;
      continue;
    }

    // Check if we're in a modal/popup section
    if (modalPatterns.some(pattern => pattern.test(line))) {
      inModal = true;
      continue;
    }

    // Exit navigation/footer after several empty lines or a main heading
    if ((inNavigation || inFooter || inModal) && line === '') {
      emptyLineCount++;
      if (emptyLineCount > 2) {
        inNavigation = false;
        inFooter = false;
        inModal = false;
        emptyLineCount = 0;
      }
      continue;
    } else if (line !== '') {
      emptyLineCount = 0;
    }

    // Check for main content headers (usually h1 or h2)
    if (/^#{1,2}\s+The most powerful/.test(line) ||
        /^#{1,2}\s+Git Made Easy/.test(line) ||
        /^#{1,2}\s+All of Git's Power/.test(line) ||
        /^#{1,2}\s+Software With Productivity/.test(line)) {
      inNavigation = false;
      inFooter = false;
      inModal = false;
      mainContentStarted = true;
    }

    // Skip lines that are in navigation, footer, or modal sections
    if (inNavigation || inFooter || inModal) {
      continue;
    }

    // Remove javascript void links
    if (line.includes('javascript:void(0)')) {
      continue;
    }

    // Remove "Also available for" links
    if (/^\[Also available for/i.test(line)) {
      continue;
    }

    // Remove social media icon links (empty links)
    if (/^\[\]\(https?:\/\/(www\.)?(facebook|twitter|x\.com|instagram|linkedin|youtube|bsky\.app)/i.test(line)) {
      continue;
    }

    mainContentStarted = true;
    cleanedLines.push(lines[i]); // Keep original formatting/indentation
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

  return result.join('\n');
}
