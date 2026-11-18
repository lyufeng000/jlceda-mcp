import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type {
  ReaApiCatalogEntry,
  ReaApiDomain,
  ReaApiKind,
  ReaDocumentTypeRequirement,
  ReaParameterSpec,
  ReaPhysicalDimension,
  ReaSecurityPolicy,
  ReaTargetContext,
  ReaUnitContract,
} from "../types/index.js";
import type { AsarMemoryVfs } from "./asar-memory-vfs.js";

export interface DtsExtractionResult {
  entries: ReaApiCatalogEntry[];
  sourceLabel: string;
  classCount: number;
  interfaceCount: number;
  enumCount: number;
  edaPropertyMap: Record<string, string>;
}

interface ParsedJsDoc {
  summaryZh: string;
  paramDescriptions: Record<string, string>;
  returnDescription: string;
  isInternal: boolean;
  isDeprecated: boolean;
}

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_JS_HINT_RE = /\b(?:await\s+eda\.|const\s+\w+\s*=|function\s*\()/g;

function sanitizeDocText(raw: string): string {
  return raw
    .replace(FENCED_CODE_RE, "")
    .replace(INLINE_CODE_JS_HINT_RE, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLeadingJsDocText(node: ts.Node, sourceFile: ts.SourceFile): string {
  const fullText = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  if (!ranges || ranges.length === 0) {
    return "";
  }
  const lastRange = ranges[ranges.length - 1];
  const raw = fullText.slice(lastRange.pos, lastRange.end);
  if (!raw.startsWith("/**")) {
    return "";
  }
  const lines = raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, ""));
  return lines.join("\n").trim();
}

function parseJsDoc(node: ts.Node, sourceFile: ts.SourceFile): ParsedJsDoc {
  const raw = getLeadingJsDocText(node, sourceFile);
  if (!raw) {
    return {
      summaryZh: "",
      paramDescriptions: {},
      returnDescription: "",
      isInternal: false,
      isDeprecated: false,
    };
  }

  const lines = raw.split(/\r?\n/);
  const summaryLines: string[] = [];
  const paramDescriptions: Record<string, string> = {};
  const returnLines: string[] = [];
  let section: "summary" | "remarks" | "param" | "returns" | "example" | "other" = "summary";
  let currentParam: string | null = null;
  let isInternal = false;
  let isDeprecated = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@internal")) {
      isInternal = true;
      section = "other";
      continue;
    }
    if (trimmed.startsWith("@deprecated")) {
      isDeprecated = true;
      section = "other";
      continue;
    }
    if (trimmed.startsWith("@example")) {
      section = "example";
      continue;
    }
    if (trimmed.startsWith("@privateRemarks") || trimmed.startsWith("@public")) {
      section = "other";
      continue;
    }
    if (trimmed.startsWith("@remarks")) {
      section = "remarks";
      const rest = trimmed.replace(/^@remarks\s*/, "");
      if (rest) summaryLines.push(rest);
      continue;
    }
    if (trimmed.startsWith("@param")) {
      section = "param";
      const m = trimmed.match(/^@param\s+([A-Za-z0-9_$]+)\s*(?:-|:)?\s*(.*)$/);
      if (m) {
        currentParam = m[1];
        paramDescriptions[currentParam] = m[2] ?? "";
      }
      continue;
    }
    if (trimmed.startsWith("@returns") || trimmed.startsWith("@return")) {
      section = "returns";
      const rest = trimmed.replace(/^@returns?\s*/, "");
      if (rest) returnLines.push(rest);
      continue;
    }
    if (trimmed.startsWith("@")) {
      section = "other";
      continue;
    }

    if (section === "example" || section === "other") {
      continue;
    }
    if (section === "summary" || section === "remarks") {
      if (trimmed) {
        summaryLines.push(trimmed);
      }
    } else if (section === "param" && currentParam) {
      if (trimmed) {
        paramDescriptions[currentParam] = `${paramDescriptions[currentParam]} ${trimmed}`.trim();
      }
    } else if (section === "returns") {
      if (trimmed) {
        returnLines.push(trimmed);
      }
    }
  }

  return {
    summaryZh: sanitizeDocText(summaryLines.join(" ")),
    paramDescriptions: Object.fromEntries(
      Object.entries(paramDescriptions).map(([k, v]) => [k, sanitizeDocText(v)])
    ),
    returnDescription: sanitizeDocText(returnLines.join(" ")),
    isInternal,
    isDeprecated,
  };
}

function hasPrivateModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  const mods = ts.getModifiers(node);
  return Boolean(
    mods?.some(
      (m) =>
        m.kind === ts.SyntaxKind.PrivateKeyword ||
        m.kind === ts.SyntaxKind.ProtectedKeyword
    )
  );
}

function inferDomain(namespaceName: string): ReaApiDomain {
  const upper = namespaceName.toUpperCase();
  if (upper.includes("SIMULATION")) return "SIM";
  if (upper.endsWith("_DRC") || upper.endsWith("_DFM")) return "DRC";
  if (upper.startsWith("SYS") || upper.startsWith("ESYS") || upper.startsWith("ISYS")) return "SYS";
  if (upper.startsWith("DMT") || upper.startsWith("EDMT") || upper.startsWith("IDMT")) return "DMT";
  if (upper.startsWith("LIB") || upper.startsWith("ELIB") || upper.startsWith("ILIB")) return "LIB";
  if (upper.startsWith("SCH") || upper.startsWith("ESCH") || upper.startsWith("ISCH")) return "SCH";
  if (
    upper.startsWith("PCB") ||
    upper.startsWith("EPCB") ||
    upper.startsWith("IPCB") ||
    upper.startsWith("PNL") ||
    upper.startsWith("EPNL") ||
    upper.startsWith("IPNL")
  ) {
    return "PCB";
  }
  return "SYS";
}

function inferTargetContext(domain: ReaApiDomain, namespaceName: string): ReaTargetContext {
  if (domain === "SCH" || domain === "SIM" || namespaceName.startsWith("SCH_")) {
    return "sch_renderer";
  }
  if (domain === "PCB" || namespaceName.startsWith("PCB_") || namespaceName.startsWith("PNL_")) {
    return "pcb_renderer";
  }
  if (domain === "DRC") {
    return namespaceName.startsWith("SCH_") ? "sch_renderer" : "pcb_renderer";
  }
  return "any_editor_renderer";
}

function inferDocRequirement(
  domain: ReaApiDomain,
  namespaceName: string
): ReaDocumentTypeRequirement[] {
  if (namespaceName.startsWith("SCH_") || domain === "SIM") return ["SCH"];
  if (namespaceName.startsWith("PCB_")) return ["PCB"];
  if (namespaceName.startsWith("PNL_")) return ["PANEL"];
  if (namespaceName.startsWith("LIB_")) return ["SYMBOL", "FOOTPRINT", "ANY"];
  return ["ANY"];
}

function inferPhysicalDimension(paramName: string, desc: string): ReaPhysicalDimension | null {
  const combined = `${paramName} ${desc}`.toLowerCase();
  if (/(?:angle|rotation|rotate|startangle|endangle|角度|旋转)/.test(combined)) {
    return "angle";
  }
  if (
    /(?:^x$|^y$|^startx$|^starty$|^endx$|^endy$|width|height|radius|diameter|drill|clearance|length|offset|spacing|pitch|margin|size|坐标|线宽|间距|直径|孔径|长度|偏移)/.test(
      combined
    )
  ) {
    return "length";
  }
  if (/(?:voltage|volt|电压)/.test(combined)) return "voltage";
  if (/(?:current|amp|电流)/.test(combined)) return "current";
  if (/(?:resistance|ohm|电阻)/.test(combined)) return "resistance";
  if (/(?:capacitance|farad|电容)/.test(combined)) return "capacitance";
  return null;
}

function inferUnitContract(
  namespaceName: string,
  memberName: string,
  params: ReaParameterSpec[]
): ReaUnitContract {
  const hasLength = params.some((p) => p.physicalDimension === "length");
  const hasAngle = params.some((p) => p.physicalDimension === "angle");
  const hasExplicitUnit = params.some((p) => /unit/i.test(p.name));

  let nativeLengthUnit: ReaUnitContract["nativeLengthUnit"] = "none";
  if (hasExplicitUnit) {
    nativeLengthUnit = "explicit_unit_param";
  } else if (hasLength) {
    if (namespaceName.startsWith("PCB_") || namespaceName.startsWith("PNL_")) {
      nativeLengthUnit = /mm/i.test(memberName) ? "mm" : "mil";
    } else if (namespaceName.startsWith("SCH_")) {
      nativeLengthUnit = "10mil";
    } else {
      nativeLengthUnit = "mm";
    }
  }

  return {
    nativeLengthUnit,
    nativeAngleUnit: hasAngle ? "deg" : "none",
    autoConvertFromMmDeg:
      nativeLengthUnit === "mil" || nativeLengthUnit === "10mil" || hasAngle,
  };
}

function inferSecurityAndSideEffects(
  memberName: string,
  namespaceName: string,
  kind: ReaApiKind
): {
  securityPolicy: ReaSecurityPolicy;
  mutatesCanvas: boolean;
  pushesUndoStep: boolean;
  writesLocalDisk: boolean;
  triggersModalDialog: boolean;
  networkRequest: boolean;
  mustWrapInTransaction: boolean;
} {
  const lower = memberName.toLowerCase();
  const nsLower = namespaceName.toLowerCase();

  const isAuthSensitive =
    /(?:login|logout|password|token|cookie|sessionkey|passport|payment)/i.test(
      `${namespaceName}.${memberName}`
    );
  if (isAuthSensitive) {
    return {
      securityPolicy: "BLOCKED",
      mutatesCanvas: false,
      pushesUndoStep: false,
      writesLocalDisk: false,
      triggersModalDialog: false,
      networkRequest: true,
      mustWrapInTransaction: false,
    };
  }

  const isModal =
    nsLower.includes("dialog") ||
    nsLower.includes("messagebox") ||
    /show(?:open|save|select)|dialog|prompt|alert/.test(lower);
  const isDiskWrite =
    /save|export|write|download|generate.*file/.test(lower) ||
    nsLower.includes("filesystem");
  const isNetwork =
    nsLower.includes("websocket") ||
    nsLower.includes("clienturl") ||
    /fetch|http|upload|download|online|cloud/.test(lower);

  const isReadOnly =
    kind === "enum" ||
    kind === "property" ||
    /^(?:get|is|has|find|search|query|check|count|list|convert|calculate|verify|to|from)/.test(
      lower
    );

  const isCanvasDomain =
    namespaceName.startsWith("SCH_") ||
    namespaceName.startsWith("PCB_") ||
    namespaceName.startsWith("PNL_");

  const isDestructive = /^(?:delete|remove|clear|destroy|drop|reset)/.test(lower);
  const mutatesCanvas =
    !isReadOnly &&
    isCanvasDomain &&
    /^(?:create|modify|update|delete|remove|set|add|place|move|rotate|pour|clear|change|sync|connect|import)/.test(
      lower
    );

  let securityPolicy: ReaSecurityPolicy = "ALLOW";
  if (isReadOnly && !isModal) {
    securityPolicy = "READ_ONLY_SAFE";
  } else if (isDestructive || isModal || nsLower.includes("project")) {
    securityPolicy = isDestructive && !isCanvasDomain ? "CONFIRM_REQUIRED" : "ALLOW";
    if (isModal || /deleteproject|deleteboard|deletepcb|deleteschematic/.test(lower)) {
      securityPolicy = "CONFIRM_REQUIRED";
    }
  }

  return {
    securityPolicy,
    mutatesCanvas,
    pushesUndoStep: mutatesCanvas,
    writesLocalDisk: isDiskWrite,
    triggersModalDialog: isModal,
    networkRequest: isNetwork,
    mustWrapInTransaction: mutatesCanvas,
  };
}

function splitCamelKeywords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function typeNodeToJsonSchema(
  typeNode: ts.TypeNode | undefined,
  enumNames: Set<string>,
  externalDefs?: Record<string, Record<string, unknown>>
): { schema: Record<string, unknown>; isComplexObject: boolean; isArray: boolean; isPromise: boolean; innerTypeName: string } {
  if (!typeNode) {
    return { schema: {}, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "any" };
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText();
    if (typeName === "Promise" && typeNode.typeArguments && typeNode.typeArguments.length > 0) {
      const inner = typeNodeToJsonSchema(typeNode.typeArguments[0], enumNames, externalDefs);
      return { ...inner, isPromise: true };
    }
    if (typeName === "Array" || typeName === "ReadonlyArray") {
      const itemArg = typeNode.typeArguments?.[0];
      const itemRes = typeNodeToJsonSchema(itemArg, enumNames, externalDefs);
      return {
        schema: { type: "array", items: itemRes.schema },
        isComplexObject: itemRes.isComplexObject,
        isArray: true,
        isPromise: false,
        innerTypeName: `Array<${itemRes.innerTypeName}>`,
      };
    }
    if (typeName === "Record" || typeName === "Map") {
      return {
        schema: { type: "object", additionalProperties: true },
        isComplexObject: true,
        isArray: false,
        isPromise: false,
        innerTypeName: typeName,
      };
    }
    if (enumNames.has(typeName)) {
      const def = externalDefs?.[typeName];
      if (def) {
        return {
          schema: {
            oneOf: [
              ...(Array.isArray(def.enum) ? [{ enum: def.enum }] : [{ type: def.type ?? "string" }]),
              { type: "object", properties: { $enum: { type: "string", pattern: `^${typeName}\\.` } }, required: ["$enum"] },
            ],
          },
          isComplexObject: false,
          isArray: false,
          isPromise: false,
          innerTypeName: typeName,
        };
      }
      return {
        schema: {
          oneOf: [
            { type: "string" },
            { type: "number" },
            { type: "object", properties: { $enum: { type: "string" } }, required: ["$enum"] },
          ],
          "x-tsType": typeName,
        },
        isComplexObject: false,
        isArray: false,
        isPromise: false,
        innerTypeName: typeName,
      };
    }

    const isInterfaceOrClass = /^I?(?:SYS|DMT|LIB|SCH|PCB|PNL)_/.test(typeName);
    return {
      schema: { type: "object", "x-tsType": typeName },
      isComplexObject: isInterfaceOrClass,
      isArray: false,
      isPromise: false,
      innerTypeName: typeName,
    };
  }

  if (ts.isArrayTypeNode(typeNode)) {
    const elem = typeNodeToJsonSchema(typeNode.elementType, enumNames, externalDefs);
    return {
      schema: { type: "array", items: elem.schema },
      isComplexObject: elem.isComplexObject,
      isArray: true,
      isPromise: false,
      innerTypeName: `${elem.innerTypeName}[]`,
    };
  }

  if (ts.isUnionTypeNode(typeNode)) {
    const nonNullish = typeNode.types.filter(
      (t) =>
        t.kind !== ts.SyntaxKind.UndefinedKeyword &&
        !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)
    );
    if (nonNullish.length === 1) {
      return typeNodeToJsonSchema(nonNullish[0], enumNames, externalDefs);
    }
    const variants = nonNullish.map((t) => typeNodeToJsonSchema(t, enumNames, externalDefs));
    return {
      schema: { oneOf: variants.map((v) => v.schema) },
      isComplexObject: variants.some((v) => v.isComplexObject),
      isArray: variants.some((v) => v.isArray),
      isPromise: false,
      innerTypeName: variants.map((v) => v.innerTypeName).join(" | "),
    };
  }

  if (ts.isLiteralTypeNode(typeNode)) {
    if (ts.isStringLiteral(typeNode.literal)) {
      return { schema: { type: "string", const: typeNode.literal.text }, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "string" };
    }
    if (ts.isNumericLiteral(typeNode.literal)) {
      return { schema: { type: "number", const: Number(typeNode.literal.text) }, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "number" };
    }
    if (typeNode.literal.kind === ts.SyntaxKind.TrueKeyword || typeNode.literal.kind === ts.SyntaxKind.FalseKeyword) {
      return { schema: { type: "boolean" }, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "boolean" };
    }
    if (typeNode.literal.kind === ts.SyntaxKind.NullKeyword) {
      return { schema: { type: "null" }, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "null" };
    }
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const member of typeNode.members) {
      if (ts.isPropertySignature(member) && member.name) {
        const key = member.name.getText().replace(/^["']|["']$/g, "");
        const propType = typeNodeToJsonSchema(member.type, enumNames, externalDefs);
        props[key] = propType.schema;
        if (!member.questionToken) {
          required.push(key);
        }
      }
    }
    return {
      schema: {
        type: "object",
        properties: props,
        ...(required.length > 0 ? { required } : {}),
      },
      isComplexObject: false,
      isArray: false,
      isPromise: false,
      innerTypeName: "object",
    };
  }

  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { schema: { type: "string" }, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "string" };
    case ts.SyntaxKind.NumberKeyword:
      return { schema: { type: "number" }, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "number" };
    case ts.SyntaxKind.BooleanKeyword:
      return { schema: { type: "boolean" }, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "boolean" };
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
      return { schema: { type: "null" }, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "void" };
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.UnknownKeyword:
      return { schema: {}, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "unknown" };
    case ts.SyntaxKind.ObjectKeyword:
      return { schema: { type: "object" }, isComplexObject: true, isArray: false, isPromise: false, innerTypeName: "object" };
    default:
      return { schema: { type: "object" }, isComplexObject: false, isArray: false, isPromise: false, innerTypeName: "object" };
  }
}

/**
 * Parse a `.d.ts` source string using TypeScript Compiler API (`ts.createProgram`
 * over an in-memory virtual `CompilerHost`), recursively traversing `declare global { ... }`
 * (`ModuleDeclaration`) blocks to extract all L1_PUBLIC classes, methods, properties,
 * enums, and root `EDA` namespace mappings.
 */
export function extractDtsFromContent(
  dtsContent: string,
  options: {
    sourceLabel?: string;
    externalSchemaDefs?: Record<string, Record<string, unknown>>;
  } = {}
): DtsExtractionResult {
  const virtualFileName = "api-types.d.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noLib: true,
    skipLibCheck: true,
  };

  const virtualSourceFile = ts.createSourceFile(
    virtualFileName,
    dtsContent,
    ts.ScriptTarget.Latest,
    true
  );

  const host: ts.CompilerHost = {
    getSourceFile: (fileName) =>
      fileName === virtualFileName ? virtualSourceFile : undefined,
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => "",
    getNewLine: () => "\n",
    fileExists: (f) => f === virtualFileName,
    readFile: (f) => (f === virtualFileName ? dtsContent : undefined),
    directoryExists: () => true,
    getDirectories: () => [],
  };

  const program = ts.createProgram([virtualFileName], compilerOptions, host);
  const sf = program.getSourceFile(virtualFileName) ?? virtualSourceFile;

  const classes: ts.ClassDeclaration[] = [];
  const enums: ts.EnumDeclaration[] = [];
  let interfaceCount = 0;

  const collectNodes = (node: ts.Node): void => {
    if (ts.isSourceFile(node)) {
      for (const stmt of node.statements) {
        collectNodes(stmt);
      }
      return;
    }
    if (ts.isModuleDeclaration(node)) {
      if (node.body && ts.isModuleBlock(node.body)) {
        for (const stmt of node.body.statements) {
          collectNodes(stmt);
        }
      } else if (node.body) {
        collectNodes(node.body);
      }
      return;
    }
    if (ts.isClassDeclaration(node)) {
      classes.push(node);
    } else if (ts.isEnumDeclaration(node)) {
      enums.push(node);
    } else if (ts.isInterfaceDeclaration(node)) {
      interfaceCount++;
    }
  };

  collectNodes(sf);

  // Build enum set and EDA property -> ClassName map
  const enumNames = new Set<string>();
  for (const en of enums) {
    enumNames.add(en.name.text);
  }

  const edaPropertyMap: Record<string, string> = {};
  const classToEdaProps = new Map<string, string[]>();

  for (const cls of classes) {
    if (cls.name?.text === "EDA") {
      for (const member of cls.members) {
        if (hasPrivateModifier(member)) continue;
        if (ts.isPropertyDeclaration(member) && member.type && ts.isTypeReferenceNode(member.type)) {
          const propName = member.name.getText(sf);
          const targetClassName = member.type.typeName.getText(sf);
          edaPropertyMap[propName] = targetClassName;
          const list = classToEdaProps.get(targetClassName) ?? [];
          list.push(propName);
          classToEdaProps.set(targetClassName, list);
        }
      }
    }
  }

  const entriesMap = new Map<string, ReaApiCatalogEntry>();

  // 1. Extract all Enums (ESYS_*, EDMT_*, ELIB_*, ESCH_*, EPCB_*, EPNL_*)
  for (const en of enums) {
    const enumName = en.name.text;
    const doc = parseJsDoc(en, sf);
    if (doc.isInternal) continue;

    const domain = inferDomain(enumName);
    const memberValues: Record<string, string | number> = {};
    let numericCounter = 0;

    for (const member of en.members) {
      const mName = member.name.getText(sf);
      if (member.initializer) {
        if (ts.isStringLiteral(member.initializer) || ts.isNoSubstitutionTemplateLiteral(member.initializer)) {
          memberValues[mName] = member.initializer.text;
        } else if (ts.isNumericLiteral(member.initializer)) {
          const n = Number(member.initializer.text);
          memberValues[mName] = n;
          numericCounter = n + 1;
        } else if (
          ts.isPrefixUnaryExpression(member.initializer) &&
          ts.isNumericLiteral(member.initializer.operand)
        ) {
          const n = -Number(member.initializer.operand.text);
          memberValues[mName] = n;
          numericCounter = n + 1;
        } else {
          memberValues[mName] = member.initializer.getText(sf);
        }
      } else {
        memberValues[mName] = numericCounter++;
      }
    }

    const apiId = `eda.${enumName}`;
    const valuesList = Object.values(memberValues);
    const enumTypes = new Set(valuesList.map((v) => typeof v));
    const schemaType =
      enumTypes.size === 1 && enumTypes.has("number") ? "number" : "string";

    entriesMap.set(apiId, {
      apiId,
      tier: "L1_PUBLIC",
      domain,
      kind: "enum",
      namespace: enumName,
      memberName: enumName,
      summaryZh: doc.summaryZh || `枚举 ${enumName}（含 ${Object.keys(memberValues).length} 个成员）`,
      keywordsEn: [
        enumName,
        ...splitCamelKeywords(enumName),
        ...Object.keys(memberValues).slice(0, 20),
        "enum",
      ],
      invocation: {
        targetContext: inferTargetContext(domain, enumName),
        asyncMode: "sync",
        bindingStrategy: "direct_global_path",
        globalPath: `window.eda.${enumName}`,
        commandKey: null,
        fingerprintAnchor: null,
      },
      unitContract: {
        nativeLengthUnit: "none",
        nativeAngleUnit: "none",
        autoConvertFromMmDeg: false,
      },
      parameters: [],
      returns: {
        descriptionZh: `${enumName} 枚举常量映射`,
        wrapAsHandleIfComplex: false,
        paginatedArray: false,
        schema: {
          type: schemaType,
          enum: valuesList,
          enumNames: Object.keys(memberValues),
          "x-enumValues": memberValues,
        },
      },
      preconditions: {
        requiresOpenProject: false,
        requiredActiveDocumentType: ["ANY"],
        requiresBoardOutline: false,
        disallowDuringInteractiveDraw: false,
      },
      sideEffects: {
        mutatesCanvas: false,
        pushesUndoStep: false,
        writesLocalDisk: false,
        triggersModalDialog: false,
        networkRequest: false,
        mustWrapInTransaction: false,
      },
      securityPolicy: "READ_ONLY_SAFE",
    });
  }

  // 2. Extract all Class methods and properties
  for (const cls of classes) {
    const className = cls.name?.text;
    if (!className || className === "EDA") continue;
    const classDoc = parseJsDoc(cls, sf);
    if (classDoc.isInternal) continue;

    const mappedProps = classToEdaProps.get(className);
    const primaryNsProp =
      mappedProps && mappedProps.length > 0
        ? mappedProps[0]
        : className.replace(/^([A-Z]+)_/, (_, p1: string) => `${p1.toLowerCase()}_`);

    const domain = inferDomain(className);
    const targetContext = inferTargetContext(domain, className);
    const reqDocTypes = inferDocRequirement(domain, className);

    for (const member of cls.members) {
      if (hasPrivateModifier(member)) continue;
      if (ts.isConstructorDeclaration(member)) continue;

      const memberDoc = parseJsDoc(member, sf);
      if (memberDoc.isInternal) continue;

      if (ts.isMethodDeclaration(member) && member.name) {
        const memberName = member.name.getText(sf);
        const apiId = `eda.${primaryNsProp}.${memberName}`;
        const globalPath = `window.eda.${primaryNsProp}.${memberName}`;

        const params: ReaParameterSpec[] = [];
        for (const param of member.parameters) {
          const pName = param.name.getText(sf).replace(/^\.\.\./, "");
          const isOptional = Boolean(param.questionToken || param.initializer || param.dotDotDotToken);
          const typeInfo = typeNodeToJsonSchema(
            param.type,
            enumNames,
            options.externalSchemaDefs
          );
          const descZh = memberDoc.paramDescriptions[pName] ?? "";
          params.push({
            name: pName,
            required: !isOptional,
            physicalDimension: inferPhysicalDimension(pName, descZh),
            ...(descZh ? { descriptionZh: descZh } : {}),
            schema: typeInfo.schema,
          });
        }

        const retInfo = typeNodeToJsonSchema(
          member.type,
          enumNames,
          options.externalSchemaDefs
        );
        const unitContract = inferUnitContract(className, memberName, params);
        const sec = inferSecurityAndSideEffects(memberName, className, "method");

        const existing = entriesMap.get(apiId);
        if (existing) {
          // Merge overloaded signature cleanly without losing optional parameters
          if (params.length > existing.parameters.length) {
            existing.parameters = params;
          }
          continue;
        }

        const summary =
          memberDoc.summaryZh ||
          `${className}.${memberName} 官方扩展接口${memberDoc.isDeprecated ? "（已弃用）" : ""}`;

        const keywords = Array.from(
          new Set([
            className,
            primaryNsProp,
            memberName,
            domain.toLowerCase(),
            ...splitCamelKeywords(className),
            ...splitCamelKeywords(memberName),
            ...params.map((p) => p.name),
          ])
        );

        entriesMap.set(apiId, {
          apiId,
          tier: "L1_PUBLIC",
          domain,
          kind: "method",
          namespace: className,
          memberName,
          summaryZh: summary,
          keywordsEn: keywords,
          invocation: {
            targetContext,
            asyncMode: retInfo.isPromise ? "promise" : "sync",
            bindingStrategy: "direct_global_path",
            globalPath,
            commandKey: null,
            fingerprintAnchor: null,
          },
          unitContract,
          parameters: params,
          returns: {
            descriptionZh: memberDoc.returnDescription || `返回 ${retInfo.innerTypeName}`,
            wrapAsHandleIfComplex: retInfo.isComplexObject,
            paginatedArray: retInfo.isArray,
            schema: retInfo.schema,
          },
          preconditions: {
            requiresOpenProject:
              domain === "SCH" || domain === "PCB" || domain === "DRC" || domain === "SIM",
            requiredActiveDocumentType: reqDocTypes,
            requiresBoardOutline: false,
            disallowDuringInteractiveDraw: sec.mutatesCanvas,
          },
          sideEffects: {
            mutatesCanvas: sec.mutatesCanvas,
            pushesUndoStep: sec.pushesUndoStep,
            writesLocalDisk: sec.writesLocalDisk,
            triggersModalDialog: sec.triggersModalDialog,
            networkRequest: sec.networkRequest,
            mustWrapInTransaction: sec.mustWrapInTransaction,
          },
          securityPolicy: sec.securityPolicy,
        });
      } else if (
        (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) &&
        member.name
      ) {
        const memberName = member.name.getText(sf);
        const apiId = `eda.${primaryNsProp}.${memberName}`;
        if (entriesMap.has(apiId)) continue;

        const retInfo = typeNodeToJsonSchema(
          member.type,
          enumNames,
          options.externalSchemaDefs
        );
        const sec = inferSecurityAndSideEffects(memberName, className, "property");
        const summary = memberDoc.summaryZh || `${className}.${memberName} 属性`;

        entriesMap.set(apiId, {
          apiId,
          tier: "L1_PUBLIC",
          domain,
          kind: "property",
          namespace: className,
          memberName,
          summaryZh: summary,
          keywordsEn: Array.from(
            new Set([
              className,
              primaryNsProp,
              memberName,
              ...splitCamelKeywords(className),
              ...splitCamelKeywords(memberName),
            ])
          ),
          invocation: {
            targetContext,
            asyncMode: "sync",
            bindingStrategy: "direct_global_path",
            globalPath: `window.eda.${primaryNsProp}.${memberName}`,
            commandKey: null,
            fingerprintAnchor: null,
          },
          unitContract: {
            nativeLengthUnit: "none",
            nativeAngleUnit: "none",
            autoConvertFromMmDeg: false,
          },
          parameters: [],
          returns: {
            descriptionZh: memberDoc.returnDescription || `属性值 (${retInfo.innerTypeName})`,
            wrapAsHandleIfComplex: retInfo.isComplexObject,
            paginatedArray: retInfo.isArray,
            schema: retInfo.schema,
          },
          preconditions: {
            requiresOpenProject: false,
            requiredActiveDocumentType: ["ANY"],
            requiresBoardOutline: false,
            disallowDuringInteractiveDraw: false,
          },
          sideEffects: {
            mutatesCanvas: false,
            pushesUndoStep: false,
            writesLocalDisk: false,
            triggersModalDialog: false,
            networkRequest: false,
            mustWrapInTransaction: false,
          },
          securityPolicy: sec.securityPolicy,
        });
      }
    }
  }

  return {
    entries: Array.from(entriesMap.values()),
    sourceLabel: options.sourceLabel ?? virtualFileName,
    classCount: classes.length,
    interfaceCount,
    enumCount: enums.length,
    edaPropertyMap,
  };
}

/**
 * Find and extract L1_PUBLIC `.d.ts` declarations from an open `AsarMemoryVfs`,
 * falling back to `@jlceda/pro-api-types` in workspace `node_modules` if absent.
 */
export function extractL1FromVfsOrPackage(options: {
  vfs?: AsarMemoryVfs | null;
  fallbackWorkspaceRoot?: string;
} = {}): DtsExtractionResult {
  const vfs = options.vfs ?? null;
  if (vfs) {
    const dtsPaths = vfs
      .listFiles("assets/pro-api/", [".d.ts"])
      .filter((p) => p.endsWith("api-types.d.ts"));
    const targetDts =
      dtsPaths[0] ?? vfs.listFiles("", [".d.ts"]).find((p) => p.endsWith("api-types.d.ts"));

    if (targetDts) {
      let externalSchemaDefs: Record<string, Record<string, unknown>> | undefined;
      const schemaCandidates = vfs
        .listFiles("assets/pro-api/", [".json"])
        .filter((p) => p.endsWith("api-types.schema.json"));
      if (schemaCandidates[0]) {
        try {
          const parsedSchema = vfs.readFileJson<{
            $defs?: Record<string, Record<string, unknown>>;
          }>(schemaCandidates[0]);
          externalSchemaDefs = parsedSchema.$defs;
        } catch {
          // Schema enrichment is optional.
        }
      }

      return vfs.withFileText(targetDts, (dtsContent) =>
        extractDtsFromContent(dtsContent, {
          sourceLabel: `${vfs.sourcePath}::${targetDts}`,
          externalSchemaDefs,
        })
      );
    }
  }

  const wsRoot = options.fallbackWorkspaceRoot ?? process.cwd();
  const npmDtsPath = path.join(wsRoot, "node_modules", "@jlceda", "pro-api-types", "index.d.ts");
  if (fs.existsSync(npmDtsPath)) {
    const content = fs.readFileSync(npmDtsPath, "utf8");
    return extractDtsFromContent(content, {
      sourceLabel: npmDtsPath,
    });
  }

  throw new Error(
    "Unable to locate api-types.d.ts in client VFS or @jlceda/pro-api-types package."
  );
}
