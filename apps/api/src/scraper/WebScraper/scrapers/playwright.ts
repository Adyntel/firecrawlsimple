import axios from "axios";
import { generateRequestParams } from "../single_url";
import { universalTimeout } from "../global";
import { Logger } from "../../../lib/logger";

/**
 * Scrapes a URL with Playwright
 * @param url The URL to scrape
 * @param waitFor The time to wait for the page to load
 * @param headers The headers to send with the request
 * @param pageOptions The options for the page
 * @returns The scraped content
 */
export async function scrapeWithPlaywright(
  url: string,
  waitFor: number = 0,
  headers?: Record<string, string>,
): Promise<{ content: string; pageStatusCode?: number; pageError?: string }> {
  const logParams = {
    url,
    scraper: "playwright",
    success: false,
    response_code: null,
    time_taken_seconds: null,
    error_message: null,
    html: "",
    startTime: Date.now(),
  };

  try {
    const reqParams = await generateRequestParams(url);
    const waitParam = reqParams["params"]?.wait ?? waitFor;

    Logger.info(`🔗 Attempting to connect to Playwright service at: ${process.env.PLAYWRIGHT_MICROSERVICE_URL}`);
    Logger.info(`📄 Scraping URL: ${url} with waitParam: ${waitParam}`);

    const response = await axios.post(
      process.env.PLAYWRIGHT_MICROSERVICE_URL,
      {
        url: url,
        wait_after_load: waitParam,
        headers: headers,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: universalTimeout + waitParam,
        transformResponse: [(data) => data],
      }
    );

    Logger.info(`✅ Playwright service responded with status: ${response.status}`);

    if (response.status !== 200) {
      Logger.debug(
        `⛏️ Playwright: Failed to fetch url: ${url} | status: ${response.status}, error: ${response.data?.pageError}`
      );
      logParams.error_message = response.data?.pageError;
      logParams.response_code = response.data?.pageStatusCode;
      return {
        content: "",
        pageStatusCode: response.data?.pageStatusCode,
        pageError: response.data?.pageError,
      };
    }

    const textData = response.data;
    try {
      const data = JSON.parse(textData);
      const html = data.content;
      logParams.success = true;
      logParams.html = html;
      logParams.response_code = data.pageStatusCode;
      logParams.error_message = data.pageError;
      return {
        content: html ?? "",
        pageStatusCode: data.pageStatusCode,
        pageError: data.pageError,
      };
    } catch (jsonError) {
      logParams.error_message = jsonError.message || jsonError;
      Logger.debug(
        `⛏️ Playwright: Error parsing JSON response for url: ${url} | Error: ${jsonError}`
      );
      return {
        content: "",
        pageStatusCode: null,
        pageError: logParams.error_message,
      };
    }
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      logParams.error_message = "Request timed out";
      Logger.error(`❌ Playwright: Request timed out for ${url}`);
      Logger.error(`⏱️ Timeout was set to: ${universalTimeout + waitParam}ms`);
    } else if (error.response) {
      // Server responded with error status
      logParams.error_message = error.message || error;
      Logger.error(`❌ Playwright service error for ${url}:`);
      Logger.error(`   Status: ${error.response.status}`);
      Logger.error(`   Status Text: ${error.response.statusText}`);
      Logger.error(`   Response data: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      // Request made but no response received
      logParams.error_message = "No response from Playwright service";
      Logger.error(`❌ Playwright: No response received for ${url}`);
      Logger.error(`   Error code: ${error.code}`);
      Logger.error(`   Error message: ${error.message}`);
      Logger.error(`   Playwright URL: ${process.env.PLAYWRIGHT_MICROSERVICE_URL}`);
    } else {
      logParams.error_message = error.message || error;
      Logger.error(`❌ Playwright: Failed to fetch url: ${url}`);
      Logger.error(`   Error: ${error.message || error}`);
    }
    return {
      content: "",
      pageStatusCode: null,
      pageError: logParams.error_message,
    };
  } finally {
    const endTime = Date.now();
    logParams.time_taken_seconds = (endTime - logParams.startTime) / 1000;
  }
}
