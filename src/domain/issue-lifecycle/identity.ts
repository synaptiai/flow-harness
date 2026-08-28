const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPOSITORY_PATTERN = /^[a-z0-9._-]{1,100}$/;
const GITHUB_NODE_ID_PATTERN = /^[^\s\p{Cc}\p{Cf}]+$/u;

export interface GitHubIssueIdentity {
  readonly host: "github.com";
  readonly owner: string;
  readonly repository: string;
  readonly repositoryIdentity: string;
  readonly number: number;
  readonly canonicalUrl: string;
}

export function canonicalGitHubRepositoryIdentity(value: string): string {
  if (value !== value.trim() || value.includes("\\") || value.includes("%")) {
    throw new Error("GitHub repository identity must be an exact owner/name value");
  }
  const segments = value.split("/");
  if (segments.length !== 2) {
    throw new Error("GitHub repository identity must be an exact owner/name value");
  }
  const owner = segments[0]?.toLowerCase();
  const repository = segments[1]?.toLowerCase();
  if (
    owner === undefined ||
    repository === undefined ||
    !OWNER_PATTERN.test(owner) ||
    owner.endsWith("-") ||
    !REPOSITORY_PATTERN.test(repository) ||
    repository.endsWith(".git") ||
    repository === "." ||
    repository === ".."
  ) {
    throw new Error("GitHub repository identity must be an exact owner/name value");
  }
  return `${owner}/${repository}`;
}

export function isValidGitHubNodeId(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && GITHUB_NODE_ID_PATTERN.test(value);
}

export function parseGitHubIssueUrl(value: string): GitHubIssueIdentity {
  if (value !== value.trim() || !/^https:\/\/github\.com\//i.test(value) || value.includes("%")) {
    invalidIssueUrl();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("GitHub issue URL must be an absolute canonical github.com URL", {
      cause: error,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    invalidIssueUrl();
  }
  const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*?)\/?$/.exec(url.pathname);
  if (match === null) invalidIssueUrl();
  const numberText = match[3];
  if (numberText === undefined || (numberText.length > 1 && numberText.startsWith("0"))) {
    invalidIssueUrl();
  }
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) invalidIssueUrl();
  const repositoryIdentity = canonicalGitHubRepositoryIdentity(`${match[1]}/${match[2]}`);
  const [owner, repository] = repositoryIdentity.split("/") as [string, string];
  return Object.freeze({
    host: "github.com",
    owner,
    repository,
    repositoryIdentity,
    number,
    canonicalUrl: `https://github.com/${repositoryIdentity}/issues/${number}`,
  });
}

function invalidIssueUrl(): never {
  throw new Error(
    "GitHub issue URL must match https://github.com/<owner>/<repository>/issues/<positive-number>",
  );
}
