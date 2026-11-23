"""Reads the business summary, sector and industry of a company from Yahoo Finance with the yfinance package.

Input on stdin: a JSON list of {"symbol": "EOAN.XETRA", "yahoo": "EOAN.DE"}.
Output on stdout: one JSON object per line, in input order.
  {"symbol", "yahoo", "name", "sector", "industry", "summary"} on success, or {"symbol", "yahoo", "error"}.
Exit code 3 means Yahoo rate limited the client. The script stops at the first rate limit and does not retry.
Yahoo's terms bar automated collection. This is for personal, educational use at small scale.
"""
import json
import sys
import time

import yfinance as yf
from yfinance.exceptions import YFRateLimitError

PAUSE_SECONDS = 1.0


def main():
    items = json.load(sys.stdin)
    for index, item in enumerate(items):
        if index:
            time.sleep(PAUSE_SECONDS)
        out = {"symbol": item["symbol"], "yahoo": item["yahoo"]}
        try:
            info = yf.Ticker(item["yahoo"]).info
            out.update({
                "name": info.get("longName") or None,
                "sector": info.get("sector") or None,
                "industry": info.get("industry") or None,
                "summary": info.get("longBusinessSummary") or None,
            })
        except YFRateLimitError:
            print(json.dumps({**out, "error": "rate_limited"}), flush=True)
            sys.exit(3)
        except Exception as error:  # one bad symbol must not stop the rest
            out["error"] = f"{type(error).__name__}: {str(error)[:120]}"
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
