`eod-bars.json` holds real EODHD end-of-day responses recorded by `scripts/record-eodhd-fixtures.ts` (window 2024-09-20 to 2024-11-08). `ENEL.MI` and `ZZZZ.US` returned HTTP 404 on the EOD plan used for recording; the file stores that status. EODHD terms govern redistribution of this data, so keep this repository private.

`universe-50.json` is constructed. Shares outstanding and CIKs are synthetic. FX comes from the recorded ECB file in `../ecb`.
