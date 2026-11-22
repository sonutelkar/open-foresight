"""Reads current shares outstanding, market cap, price and currency from Yahoo Finance with the yfinance package.

Input on stdin: a JSON list of {"symbol": "SAP.XETRA", "yahoo": "SAP.DE"}.
Output on stdout: one JSON object per line, in input order.
  {"symbol", "yahoo", "shares", "marketCap", "price", "currency"} on success, or {"symbol", "yahoo", "error"}.
Exit code 3 means Yahoo rate limited the client. The script stops at the first rate limit and does not retry.
Yahoo's terms bar automated collection. This is for personal, educational use at small scale.
"""
import json
import sys
import time

import yfinance as yf
from yfinance.exceptions import YFRateLimitError

PAUSE_SECONDS = 1.0


def number(value):
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and out > 0 else None


def read(yahoo):
    info = yf.Ticker(yahoo).fast_info
    return {
        "shares": number(info.get("shares")),
        "marketCap": number(info.get("marketCap")),
        "price": number(info.get("lastPrice")),
        "currency": info.get("currency") or None,
    }


def main():
    items = json.load(sys.stdin)
    for index, item in enumerate(items):
        if index:
            time.sleep(PAUSE_SECONDS)
        out = {"symbol": item["symbol"], "yahoo": item["yahoo"]}
        try:
            out.update(read(item["yahoo"]))
        except YFRateLimitError:
            print(json.dumps({**out, "error": "rate_limited"}), flush=True)
            sys.exit(3)
        except Exception as error:  # one bad symbol must not stop the rest
            out["error"] = f"{type(error).__name__}: {str(error)[:120]}"
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
