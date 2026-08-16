import {
  type FlowPresentationWidget,
  orderedPresentationWidgets,
  type PresentationPackageSnapshot,
  presentationPackageDensity,
} from "../capability/presentation-packages.js";
import {
  type FlowPresentationDocument,
  parseFlowPresentationDocument,
} from "./flow-presentation.js";

export class PresentationPackageProjectionError extends Error {
  override readonly name = "PresentationPackageProjectionError";

  constructor() {
    super("Cannot apply Flow presentation package");
  }
}

export function applyPresentationPackage(
  input: FlowPresentationDocument,
  snapshot: PresentationPackageSnapshot,
): FlowPresentationDocument {
  try {
    const document = parseFlowPresentationDocument(input);
    assertProjectableDocument(document);
    const ordered = orderedPresentationWidgets(snapshot);
    const available = ordered.flatMap((item) => {
      const section = sectionForWidget(document, item.widget);
      return section === undefined ? [] : [{ ...item, section }];
    });
    const sections = available.map((item, index) => {
      const next = available[index + 1];
      const separated =
        item.group !== null && item.group === next?.group && item.variant === "separated";
      return {
        ...item.section,
        components: [
          ...item.section.components,
          ...(separated ? [{ kind: "divider" as const }] : []),
        ],
      };
    });
    return parseFlowPresentationDocument({
      ...document,
      layout: { density: presentationPackageDensity(snapshot) },
      sections,
    });
  } catch {
    throw new PresentationPackageProjectionError();
  }
}

function assertProjectableDocument(document: FlowPresentationDocument): void {
  const supportedSections = new Set(["overview", "nodes", "resources", "approvals", "outcome"]);
  if (document.sections.some((section) => !supportedSections.has(section.id))) {
    throw new PresentationPackageProjectionError();
  }
  const overview = document.sections.find((section) => section.id === "overview");
  if (overview === undefined || overview.components.length !== 3) {
    throw new PresentationPackageProjectionError();
  }
  const kinds = overview.components.map((component) => component.kind);
  if (
    kinds.filter((kind) => kind === "heading").length !== 1 ||
    kinds.filter((kind) => kind === "facts").length !== 1 ||
    kinds.filter((kind) => kind === "progress").length !== 1
  ) {
    throw new PresentationPackageProjectionError();
  }
}

function sectionForWidget(
  document: FlowPresentationDocument,
  widget: FlowPresentationWidget,
): FlowPresentationDocument["sections"][number] | undefined {
  const overview = document.sections.find((section) => section.id === "overview");
  switch (widget) {
    case "run-summary": {
      if (overview === undefined) {
        throw new PresentationPackageProjectionError();
      }
      const components = overview.components.filter(
        (component) => component.kind === "heading" || component.kind === "facts",
      );
      if (components.length !== 2) {
        throw new PresentationPackageProjectionError();
      }
      return { id: "run-summary", title: "Run overview", components };
    }
    case "graph-progress": {
      const progress = overview?.components.find((component) => component.kind === "progress");
      if (progress === undefined) {
        throw new PresentationPackageProjectionError();
      }
      return { id: "graph-progress", title: "Graph progress", components: [progress] };
    }
    case "node-table": {
      const section = document.sections.find((candidate) => candidate.id === "nodes");
      if (section === undefined) {
        throw new PresentationPackageProjectionError();
      }
      return { ...section, id: "node-table", title: "Nodes" };
    }
    case "resource-facts": {
      const section = document.sections.find((candidate) => candidate.id === "resources");
      if (section === undefined) {
        throw new PresentationPackageProjectionError();
      }
      return { ...section, id: "resource-facts" };
    }
    case "pending-approvals": {
      const section = document.sections.find((candidate) => candidate.id === "approvals");
      return section === undefined ? undefined : { ...section, id: "pending-approvals" };
    }
    case "outcome-notice": {
      const section = document.sections.find((candidate) => candidate.id === "outcome");
      return section === undefined ? undefined : { ...section, id: "outcome-notice" };
    }
  }
}
