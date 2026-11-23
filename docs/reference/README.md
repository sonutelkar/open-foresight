# Reference holdings

`grid-holdings-2026-11-20.csv` holds the 132 holdings of the First Trust NASDAQ Clean Edge Smart Grid Infrastructure Index Fund (GRID) as of 2026-11-20. It was copied from the fund's public holdings page at https://www.ftportfolios.com/Retail/Etf/EtfHoldings.aspx?Ticker=GRID on 2026-11-22, and the weights sum to 100%. Identifiers use the page's Bloomberg style exchange suffixes, such as `SU.FP` for Euronext Paris. This is the frozen pilot reference for the recall check, so do not refresh it.

## Frozen issuer files, as of 2026-11-20

Downloaded on 2026-11-23 from each issuer. They are the frozen references for the Phase 2 recall checks, so do not refresh them. Holdings counts differ across sources and dates, so use only these files.

| Fund | Theme | File | Rows | Source | sha256 |
| --- | --- | --- | --- | --- | --- |
| GRID | Smart Energy | `grid-holdings-2026-11-20.csv` | 132 | First Trust holdings page | `bd123c0d0f0cc031fdc5fa440bbdf814244867a9fbb6fdf7ca6817f01a5b2fb1` |
| CIBR | Cybersecurity | `cibr-holdings-2026-11-20.csv` | 47 | First Trust holdings page, same layout as GRID, weights sum to 100.02% | `36b34a93149586d66276347a9a0654ddfaa0f35d5866436559514618c5a3bc98` |
| BOTZ | Robotics & AI | `botz-holdings-2026-11-20.csv` | 87 | Global X full holdings CSV, kept as downloaded with its header and disclaimer lines, weights sum to 100.11% | `557e00e228687a6f73d8fddc3191eb2850c54eb735095fa199f35ef7ad29ea54` |
| ICLN | Smart Energy, second reference | `icln-holdings-2026-11-20.csv` (the Holdings sheet) and `icln-fund-2026-11-20.xls` (the file as downloaded) | 138 rows, of which 101 are equities and the rest cash or derivatives | iShares fund page, downloaded by hand on 2026-11-23, 102 securities excluding cash per the issuer | csv `305aa53b5d3cd9fe0be81a5639056fdfc917daa96a0bbc05ab3817f3110f372f`, xls `b4dc6abaf7958d7863f9b9ed3ca7698299c652aff4ad7b9b80fe8f738851b546` |

CIBR uses `https://www.ftportfolios.com/Retail/Etf/EtfHoldings.aspx?Ticker=CIBR`. BOTZ uses `https://assets.globalxetfs.com/funds/holdings/botz_full-holdings_20261120.csv`. The GRID hash was computed on 2026-11-23 from the file as committed.
