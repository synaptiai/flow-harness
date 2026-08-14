export type NodePackageIdentityCase =
  | {
      readonly label: string;
      readonly manifest: Readonly<Record<string, unknown>>;
      readonly outcome: "reject" | "skip";
    }
  | {
      readonly identity: Readonly<{ name: string; version: string }>;
      readonly label: string;
      readonly manifest: Readonly<Record<string, unknown>>;
      readonly outcome: "accept";
    };

const exactIdentity = "x".repeat(256);
const overIdentity = "x".repeat(257);

export const nodePackageIdentityCases: readonly NodePackageIdentityCase[] = Object.freeze([
  { label: "both fields absent", manifest: {}, outcome: "skip" },
  { label: "name absent", manifest: { version: "1.0.0" }, outcome: "skip" },
  { label: "version absent", manifest: { name: "selected" }, outcome: "skip" },
  { label: "name is not a string", manifest: { name: 1, version: "1.0.0" }, outcome: "skip" },
  { label: "version is not a string", manifest: { name: "selected", version: 1 }, outcome: "skip" },
  {
    identity: { name: exactIdentity, version: "1.0.0" },
    label: "name has exactly 256 characters",
    manifest: { name: exactIdentity, version: "1.0.0" },
    outcome: "accept",
  },
  {
    identity: { name: "selected", version: exactIdentity },
    label: "version has exactly 256 characters",
    manifest: { name: "selected", version: exactIdentity },
    outcome: "accept",
  },
  {
    label: "name has 257 characters",
    manifest: { name: overIdentity, version: "1.0.0" },
    outcome: "reject",
  },
  {
    label: "version has 257 characters",
    manifest: { name: "selected", version: overIdentity },
    outcome: "reject",
  },
  {
    label: "name contains a control character",
    manifest: { name: "selected\u0000name", version: "1.0.0" },
    outcome: "reject",
  },
  {
    label: "version contains a control character",
    manifest: { name: "selected", version: "1.0.0\u007f" },
    outcome: "reject",
  },
]);
