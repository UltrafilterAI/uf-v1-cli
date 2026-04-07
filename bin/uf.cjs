#!/usr/bin/env node
"use strict";

const { main } = require("../dist/main.js");

Promise.resolve(main(process.argv.slice(2)))
  .then((code) => {
    process.exitCode = Number(code || 0);
  })
  .catch((err) => {
    process.stderr.write(`${String((err && err.message) || err)}\n`);
    process.exitCode = 1;
  });

