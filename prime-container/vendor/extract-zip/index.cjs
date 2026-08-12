"use strict";

module.exports = async function disabledExtractZip() {
  throw new Error("ZIP extraction is disabled in the Flow Prime runtime");
};
