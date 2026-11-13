# Cross-validation of calculations

`bash tools/validate/run.sh` compares Thistle Flow with independent open-source code:

| What | Reference | Result at v0.15.1 |
|---|---|---|
| Reading FCS 2.0, 3.0 and 3.1 files (BD, Thermo, Beckman, Cytek and others; log amplification, gain, integer and float data) | [flowio](https://github.com/whitews/FlowIO) and its test files | identical, or within float32 rounding (6×10⁻⁸) |
| Compensation (raw × inverse of the spillover matrix) | `flowutils.compensate` | within float32 rounding (6×10⁻⁸) |
| Logicle display scale | `flowutils.transforms.logicle` | within 2×10⁻⁸ display units (lookup table), 10⁻⁹ exact |
| Arcsinh | numpy | 2×10⁻¹⁶ |

Known, intended differences:
- **Time** is kept in the instrument's time units; flowio multiplies it by `$TIMESTEP` (seconds).
- **`$PnG` on floating-point data** is not applied (FCS 3.2 restricts `$PnG` to integer data); flowio divides by it.
- **Files whose HEADER and TEXT data offsets disagree**: FCS 3 files use `$BEGINDATA`/`$ENDDATA` from TEXT, with a warning.

Statistics (median, percentiles, SD, CV, robust CV) are checked against numpy definitions in `test/core.test.js`
and `test/review.test.js`; Logicle reference values from flowutils are stored in `test/fixtures/logicle_flowutils.json`
so `npm test` checks them without Python.
