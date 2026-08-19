# Repository instructions

## Documentation

These instructions apply to the entire repository.

- Follow [`docs/documentation-style.md`](docs/documentation-style.md) for every public document.

- Use the [Google Developer Documentation Style Guide](https://developers.google.com/style) as the
  editorial baseline. Apply repository-specific rules first, then the Google guide.

- Treat `README.md` as a concise landing page. Put detailed guidance in the canonical document
  selected by `docs/README.md`.

- Preserve exact code identifiers, CLI grammar, schema fields, error codes, quotations, and
  security requirements. Accuracy and compatibility take precedence over stylistic rewriting.

- Write task guidance for the reader. Prefer second person, active voice, direct imperatives,
  sentence-case headings, descriptive links, and US English.

- Write for a global and accessible audience. Avoid idioms, figurative language, visual-only
  directions, empty image alternatives, and unexplained jargon.

- Use `must` for requirements, `can` for permitted actions, and `might` for possibilities. Avoid
  ambiguous uses of `should` in normative contracts.

- Before committing documentation, run `npm run docs:style`, `npm run docs:links`, and
  `npm run docs:ste`. Review the prose manually for the rules that automation cannot judge.

When the Google guide changes, update the public style policy and its high-confidence automated
checks in the same change.
