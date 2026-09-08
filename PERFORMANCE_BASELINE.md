# Performance baseline

The repository includes a small deterministic benchmark for the library's
virtualized window calculation. It exercises 500, 5,000, and 10,000-book
datasets at several scroll positions without rendering a browser or contacting
Kavita.

Run it with:

```bash
npm ci
npm run benchmark:library
```

Record the benchmark output with the commit, OS, CPU, Node version, and whether
the run was warm or cold. Compare measurements on the same machine and dataset;
Vitest's operations per second are useful for detecting regressions but are not
a user-visible frame-rate guarantee. Use the browser/device acceptance matrix
for scroll frame time, memory, bridge calls, and network measurements.
