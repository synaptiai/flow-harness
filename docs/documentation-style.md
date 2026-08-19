# Documentation style

Flow documentation follows the
[Google Developer Documentation Style Guide](https://developers.google.com/style) after applying
the project-specific rules in this document.

Use this policy for every public Markdown document in the repository. The automated corpus includes
root documents, `docs/`, contributor-facing `.github/` Markdown, and user-facing `examples/`
Markdown. Executable evaluation `TASK.md` and `RESULT.md` payloads, internal decision journals,
test fixtures, generated files, and vendored material follow their owning data or evidence
contracts instead. This policy also applies to CLI help and explanatory error guidance.

## Apply the authority order

Use the following sources in order:

1. Preserve Flow's executable contracts, security requirements, compatibility promises, and
   documented evidence.
2. Apply this project policy.
3. Apply the Google guide, including its
   [style highlights](https://developers.google.com/style/highlights) and
   [word list](https://developers.google.com/style/word-list).

Keep exact identifiers unchanged. These identifiers include CLI syntax, schema fields, state names,
error codes, paths, code excerpts, and quotations. If an editorial change could alter a contract,
rewrite the surrounding explanation instead of the identifier.

## Write for the reader

- Address the reader as **you** in task-oriented documentation.
- Prefer active voice and identify the actor when responsibility matters.
- Use a conversational, respectful, and direct tone without slang, humor, idioms, or promotional
  claims.
- Use US English, serial commas, and unambiguous dates.
- Define unfamiliar terms and abbreviations on first use, and use one term for each concept.

- Put conditions before instructions so readers can skip steps that don't apply.
- Distinguish facts, requirements, recommendations, inferences, and unknowns.

For more guidance, see Google's pages about
[voice and tone](https://developers.google.com/style/tone),
[global audiences](https://developers.google.com/style/translation), and
[inclusive documentation](https://developers.google.com/style/inclusive-documentation).

## Structure each page

- Give each page one descriptive level-one heading.
- Use sentence case in a logical hierarchy without skipping heading levels.
- Start practical task headings with an imperative verb and use noun phrases for reference sections.
- Put the most important information first, and split long sections with headings and lists.
- Use numbered lists for ordered procedures and bulleted lists for unordered information.
- Introduce each table and use a short list when it is easier to scan.

See Google's guidance for [headings and titles](https://developers.google.com/style/headings) and
[accessible documentation](https://developers.google.com/style/accessibility).

## Write procedures

1. State the outcome and prerequisites before the steps.

2. Begin each step with an imperative verb and keep the action explicit.

3. Give the reader the preferred path instead of an unranked list of alternatives.

4. Explain what a command does before its code block. Don't introduce a block with “run the
   following command.”

5. Mark an optional step with **Optional:** at the start of the step.

6. State the expected result and a recovery path for likely failures.

See Google's complete [procedure guidance](https://developers.google.com/style/procedures).

## Format technical content

- Put filenames, paths, commands, flags, identifiers, status codes, and literal values in code
  font.

- Use descriptive link text that names the destination, never “here,” “this link,” or “learn more.”

- Reserve **bold** for UI elements or necessary emphasis, not document structure.

- Give every informative image alt text so the document remains understandable without the image.

- Refer to a section by name instead of using directional references such as “above” or “below.”

- Write **and** as a conjunction, except when code or an official name contains an ampersand.

See Google's [text-formatting](https://developers.google.com/style/text-formatting) and
[cross-reference](https://developers.google.com/style/cross-references) guidance.

## Write precise contracts

- Use **must** for a requirement.
- Use **can** for permission or capability.
- Use **might** for a possible outcome.
- State and explain a recommendation without using normative **should**.
- Preserve the owning specification's exact uncertainty terms instead of making a stronger claim.
- Exclude raw private values, secrets, paths, and nested causes from public examples and diagnostics.

For the general modality rules, see Google's guidance for
[prescriptive documentation](https://developers.google.com/style/prescriptive-documentation).

## Keep one canonical owner

The [documentation hub](README.md) assigns each topic to one document category. Add detailed prose
to that owner and link to it from related pages. Don't copy a contract into the root README or a
second guide.

- `README.md` introduces Flow and routes readers.
- Task guides explain how to complete a user or operator goal.
- Operations runbooks cover host preparation and recovery-sensitive work.
- Specifications define executable and persisted contracts.
- Architecture documents explain boundaries, dependencies, and non-goals.

## Review and validate changes

Before you publish documentation:

1. Confirm that the page names its audience, outcome, prerequisites, and relevant safety boundary.

2. Confirm that the documentation hub links to the page and assigns one canonical owner.

3. Check every command, path, option, version, limit, and compatibility claim against the current
   implementation.

4. Update the [Mermaid architecture diagram](architecture.md#architecture-at-a-glance) and
   repository map for a structural change. This requirement covers runtime modules, entry points,
   execution boundaries, durable stores, external trust dependencies, and ownership relationships.

5. Remove duplicated contracts and link to their owner.

6. Review the page for active voice, second person, accessibility, inclusive language, and global
   readability.

7. Run the documentation gates:

   ```sh
   npm run docs:style
   npm run docs:links
   npm run docs:ste
   ```

`docs:style` checks the complete public Markdown corpus defined in this document for objective
structural and editorial rules. `docs:links` validates local files and anchors in the same corpus.
`docs:ste` checks changed prose for the repository's clarity constraints. Passing these commands
doesn't replace technical and editorial review.
