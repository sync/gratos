// TypeScript 5's NodeFactory signatures (the 49 functions the engine's codegen calls), built on
// TypeScript 7's factory. TypeScript 7 takes extra arguments (flags, token flags, postfix tokens),
// takes identifiers where TypeScript 5 also took strings, and has no createTrue/createNull/
// createModifier/createAssignment/createEquality/createPropertyAccessChain/createPropertySignature;
// those are built from the nodes TypeScript 7 does have. Arrays are always passed where TypeScript 7
// builds a NodeArray unconditionally (createCallExpression's arguments).
import { NodeFlags, SyntaxKind } from "typescript/unstable/ast";
import type {
  ArrayLiteralExpression,
  AsteriskToken,
  BinaryExpression,
  BinaryOperator,
  BinaryOperatorToken,
  BindingName,
  Block,
  CallExpression,
  DotDotDotToken,
  EntityName,
  ExclamationToken,
  ExportDeclaration,
  ExportSpecifier,
  Expression,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  ImportAttributes,
  ImportClause,
  ImportDeclaration,
  ImportSpecifier,
  KeywordExpression,
  KeywordTypeNode,
  KeywordTypeSyntaxKind,
  MemberName,
  MethodDeclaration,
  Modifier,
  ModifierLike,
  ModifierSyntaxKind,
  ModuleExportName,
  NamedExportBindings,
  NamedExports,
  NamedImportBindings,
  NamedImports,
  NewExpression,
  Node,
  NodeArray,
  NumericLiteral,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  ParameterDeclaration,
  PropertyAccessExpression,
  PropertyAssignment,
  PropertyName,
  PropertySignatureDeclaration,
  QuestionDotToken,
  QuestionToken,
  ReturnStatement,
  ShorthandPropertyAssignment,
  SpreadAssignment,
  SpreadElement,
  Statement,
  StringLiteral,
  ThrowStatement,
  TypeAliasDeclaration,
  TypeElement,
  TypeLiteralNode,
  TypeNode,
  TypeOfExpression,
  TypeParameterDeclaration,
  TypeReferenceNode,
  UnionTypeNode,
  VariableDeclaration,
  VariableDeclarationList,
  VariableStatement,
  WhileStatement,
  AwaitExpression,
  ExpressionStatement,
} from "typescript/unstable/ast";
import {
  createArrayLiteralExpression as createArrayLiteralExpression7,
  createAwaitExpression,
  createBinaryExpression as createBinaryExpression7,
  createBlock,
  createCallExpression as createCallExpression7,
  createExportDeclaration as createExportDeclaration7,
  createExportSpecifier as createExportSpecifier7,
  createExpressionStatement,
  createFunctionDeclaration as createFunctionDeclaration7,
  createIdentifier,
  createIfStatement,
  createImportClause as createImportClause7,
  createImportDeclaration,
  createImportSpecifier,
  createKeywordExpression,
  createKeywordTypeNode,
  createMethodDeclaration as createMethodDeclaration7,
  createNamedExports,
  createNamedImports,
  createNewExpression as createNewExpression7,
  createNodeArray as createNodeArray7,
  createNumericLiteral as createNumericLiteral7,
  createObjectLiteralExpression as createObjectLiteralExpression7,
  createParameterDeclaration as createParameterDeclaration7,
  createPropertyAccessExpression as createPropertyAccessExpression7,
  createPropertyAssignment as createPropertyAssignment7,
  createPropertySignatureDeclaration,
  createReturnStatement,
  createShorthandPropertyAssignment as createShorthandPropertyAssignment7,
  createSpreadAssignment,
  createSpreadElement,
  createStringLiteral as createStringLiteral7,
  createThrowStatement,
  createToken,
  createTypeAliasDeclaration as createTypeAliasDeclaration7,
  createTypeLiteralNode as createTypeLiteralNode7,
  createTypeOfExpression,
  createTypeParameterDeclaration as createTypeParameterDeclaration7,
  createTypeReferenceNode as createTypeReferenceNode7,
  createUnionTypeNode,
  createVariableDeclaration as createVariableDeclaration7,
  createVariableDeclarationList as createVariableDeclarationList7,
  createVariableStatement as createVariableStatement7,
  createWhileStatement,
  updateMethodDeclaration as updateMethodDeclaration7,
} from "typescript/unstable/ast/factory";

/** TokenFlags.None and TokenFlags.SingleQuote, as TypeScript 5 sets them for string literals. */
const TOKEN_FLAGS_NONE = 0;
const TOKEN_FLAGS_SINGLE_QUOTE = 1 << 1;

const identifierOf = (name: string | Identifier): Identifier =>
  typeof name === "string" ? createIdentifier(name) : name;
const nameOf = <T extends Node>(name: string | T): T | Identifier =>
  typeof name === "string" ? createIdentifier(name) : name;

type Operator = BinaryOperator | BinaryOperatorToken;
const operatorTokenOf = (operator: Operator): BinaryOperatorToken =>
  typeof operator === "number" ? createToken(operator) : operator;

// TypeScript 7 types these optional children as required parameters, but its nodes take them
// absent, as TypeScript 5's factory does.
// oxlint-disable-next-line quality/no-chained-type-assertions -- see above.
const ABSENT_TYPE = undefined as unknown as TypeNode;
// oxlint-disable-next-line quality/no-chained-type-assertions -- see above.
const ABSENT_INITIALIZER = undefined as unknown as Expression;

const createBinaryExpression = (
  left: Expression,
  operator: Operator,
  right: Expression,
): BinaryExpression =>
  createBinaryExpression7(undefined, left, undefined, operatorTokenOf(operator), right);

export const factory = {
  createIdentifier,
  createPropertyAssignment: (
    name: string | PropertyName,
    initializer: Expression,
  ): PropertyAssignment =>
    createPropertyAssignment7(undefined, nameOf(name), undefined, ABSENT_TYPE, initializer),
  createStringLiteral: (text: string, isSingleQuote?: boolean): StringLiteral =>
    createStringLiteral7(
      text,
      isSingleQuote === true ? TOKEN_FLAGS_SINGLE_QUOTE : TOKEN_FLAGS_NONE,
    ),
  createReturnStatement: (expression?: Expression): ReturnStatement =>
    createReturnStatement(expression),
  createTypeReferenceNode: (
    typeName: string | EntityName,
    typeArguments?: ReadonlyArray<TypeNode>,
  ): TypeReferenceNode => createTypeReferenceNode7(nameOf(typeName), typeArguments),
  createNewExpression: (
    expression: Expression,
    typeArguments: ReadonlyArray<TypeNode> | undefined,
    argumentsArray: ReadonlyArray<Expression> | undefined,
  ): NewExpression => createNewExpression7(expression, typeArguments, argumentsArray),
  createPropertyAccessExpression: (
    expression: Expression,
    name: string | MemberName,
  ): PropertyAccessExpression =>
    createPropertyAccessExpression7(expression, undefined, nameOf(name), NodeFlags.None),
  createCallExpression: (
    expression: Expression,
    typeArguments: ReadonlyArray<TypeNode> | undefined,
    argumentsArray: ReadonlyArray<Expression> | undefined,
  ): CallExpression =>
    createCallExpression7(
      expression,
      undefined,
      typeArguments,
      argumentsArray ?? [],
      NodeFlags.None,
    ),
  createBlock: (statements: ReadonlyArray<Statement>, multiLine?: boolean): Block =>
    createBlock(statements, multiLine),
  createVariableStatement: (
    modifiers: ReadonlyArray<ModifierLike> | undefined,
    declarationList: VariableDeclarationList | ReadonlyArray<VariableDeclaration>,
  ): VariableStatement =>
    createVariableStatement7(
      modifiers,
      "kind" in declarationList
        ? declarationList
        : createVariableDeclarationList7(declarationList, NodeFlags.None),
    ),
  createVariableDeclarationList: (
    declarations: ReadonlyArray<VariableDeclaration>,
    flags?: NodeFlags,
  ): VariableDeclarationList =>
    createVariableDeclarationList7(declarations, flags ?? NodeFlags.None),
  createVariableDeclaration: (
    name: string | BindingName,
    exclamationToken?: ExclamationToken,
    type?: TypeNode,
    initializer?: Expression,
  ): VariableDeclaration =>
    createVariableDeclaration7(nameOf(name), exclamationToken, type, initializer),
  createModifier: (kind: ModifierSyntaxKind): Modifier => createToken(kind),
  createArrayLiteralExpression: (
    elements?: ReadonlyArray<Expression>,
    multiLine?: boolean,
  ): ArrayLiteralExpression => createArrayLiteralExpression7(elements ?? [], multiLine),
  createTrue: (): KeywordExpression<SyntaxKind.TrueKeyword> =>
    createKeywordExpression(SyntaxKind.TrueKeyword),
  createFalse: (): KeywordExpression<SyntaxKind.FalseKeyword> =>
    createKeywordExpression(SyntaxKind.FalseKeyword),
  createNull: (): KeywordExpression<SyntaxKind.NullKeyword> =>
    createKeywordExpression(SyntaxKind.NullKeyword),
  createParameterDeclaration: (
    modifiers: ReadonlyArray<ModifierLike> | undefined,
    dotDotDotToken: DotDotDotToken | undefined,
    name: string | BindingName,
    questionToken?: QuestionToken,
    type?: TypeNode,
    initializer?: Expression,
  ): ParameterDeclaration =>
    createParameterDeclaration7(
      modifiers,
      dotDotDotToken,
      nameOf(name),
      questionToken,
      type,
      initializer,
    ),
  createIfStatement: (
    expression: Expression,
    thenStatement: Statement,
    elseStatement?: Statement,
  ): IfStatement => createIfStatement(expression, thenStatement, elseStatement),
  createFunctionDeclaration: (
    modifiers: ReadonlyArray<ModifierLike> | undefined,
    asteriskToken: AsteriskToken | undefined,
    name: string | Identifier | undefined,
    typeParameters: ReadonlyArray<TypeParameterDeclaration> | undefined,
    parameters: ReadonlyArray<ParameterDeclaration>,
    type: TypeNode | undefined,
    body: Block | undefined,
  ): FunctionDeclaration =>
    createFunctionDeclaration7(
      modifiers,
      asteriskToken,
      name === undefined ? undefined : identifierOf(name),
      typeParameters,
      parameters,
      type,
      body,
    ),
  createTypeLiteralNode: (members: ReadonlyArray<TypeElement> | undefined): TypeLiteralNode =>
    createTypeLiteralNode7(members ?? []),
  createThrowStatement: (expression: Expression): ThrowStatement =>
    createThrowStatement(expression),
  createPropertySignature: (
    modifiers: ReadonlyArray<ModifierLike> | undefined,
    name: string | PropertyName,
    questionToken: QuestionToken | undefined,
    type: TypeNode | undefined,
  ): PropertySignatureDeclaration =>
    createPropertySignatureDeclaration(
      modifiers,
      nameOf(name),
      questionToken,
      type ?? ABSENT_TYPE,
      ABSENT_INITIALIZER,
    ),
  createObjectLiteralExpression: (
    properties?: ReadonlyArray<ObjectLiteralElementLike>,
    multiLine?: boolean,
  ): ObjectLiteralExpression => createObjectLiteralExpression7(properties ?? [], multiLine),
  createImportSpecifier: (
    isTypeOnly: boolean,
    propertyName: ModuleExportName | undefined,
    name: Identifier,
  ): ImportSpecifier => createImportSpecifier(isTypeOnly, propertyName, name),
  createImportDeclaration: (
    modifiers: ReadonlyArray<ModifierLike> | undefined,
    importClause: ImportClause | undefined,
    moduleSpecifier: Expression,
    attributes?: ImportAttributes,
  ): ImportDeclaration =>
    createImportDeclaration(modifiers, importClause, moduleSpecifier, attributes),
  /** TypeScript 5.9 still accepts `isTypeOnly: boolean` in place of the phase modifier. */
  createImportClause: (
    phaseModifier: boolean | SyntaxKind.TypeKeyword | SyntaxKind.DeferKeyword | undefined,
    name: Identifier | undefined,
    namedBindings: NamedImportBindings | undefined,
  ): ImportClause =>
    createImportClause7(
      phaseModifier === true
        ? SyntaxKind.TypeKeyword
        : phaseModifier === false
          ? undefined
          : phaseModifier,
      name,
      namedBindings,
    ),
  createExpressionStatement: (expression: Expression): ExpressionStatement =>
    createExpressionStatement(expression),
  createBinaryExpression,
  createAwaitExpression: (expression: Expression): AwaitExpression =>
    createAwaitExpression(expression),
  createWhileStatement: (expression: Expression, statement: Statement): WhileStatement =>
    createWhileStatement(expression, statement),
  createUnionTypeNode: (types: ReadonlyArray<TypeNode>): UnionTypeNode =>
    createUnionTypeNode(types),
  createTypeParameterDeclaration: (
    modifiers: ReadonlyArray<ModifierLike> | undefined,
    name: string | Identifier,
    constraint?: TypeNode,
    defaultType?: TypeNode,
  ): TypeParameterDeclaration =>
    createTypeParameterDeclaration7(
      modifiers,
      identifierOf(name),
      constraint,
      undefined,
      defaultType,
    ),
  createTypeOfExpression: (expression: Expression): TypeOfExpression =>
    createTypeOfExpression(expression),
  createTypeAliasDeclaration: (
    modifiers: ReadonlyArray<ModifierLike> | undefined,
    name: string | Identifier,
    typeParameters: ReadonlyArray<TypeParameterDeclaration> | undefined,
    type: TypeNode,
  ): TypeAliasDeclaration =>
    createTypeAliasDeclaration7(modifiers, identifierOf(name), typeParameters, type),
  createSpreadElement: (expression: Expression): SpreadElement => createSpreadElement(expression),
  createSpreadAssignment: (expression: Expression): SpreadAssignment =>
    createSpreadAssignment(expression),
  createShorthandPropertyAssignment: (
    name: string | Identifier,
    objectAssignmentInitializer?: Expression,
  ): ShorthandPropertyAssignment =>
    createShorthandPropertyAssignment7(
      undefined,
      identifierOf(name),
      undefined,
      ABSENT_TYPE,
      undefined,
      objectAssignmentInitializer,
    ),
  /** TypeScript 5 marks the access as part of an optional chain; the printer then parenthesizes calls on it. */
  createPropertyAccessChain: (
    expression: Expression,
    questionDotToken: QuestionDotToken | undefined,
    name: string | MemberName,
  ): PropertyAccessExpression =>
    createPropertyAccessExpression7(
      expression,
      questionDotToken,
      nameOf(name),
      NodeFlags.OptionalChain,
    ),
  createNumericLiteral: (value: string | number, numericLiteralFlags?: number): NumericLiteral =>
    createNumericLiteral7(
      typeof value === "number" ? `${value}` : value,
      numericLiteralFlags ?? TOKEN_FLAGS_NONE,
    ),
  createNodeArray: <T extends Node>(elements?: ReadonlyArray<T>): NodeArray<T> =>
    createNodeArray7(elements ?? []),
  createNamedImports: (elements: ReadonlyArray<ImportSpecifier>): NamedImports =>
    createNamedImports(elements),
  createNamedExports: (elements: ReadonlyArray<ExportSpecifier>): NamedExports =>
    createNamedExports(elements),
  createMethodDeclaration: (
    modifiers: ReadonlyArray<ModifierLike> | undefined,
    asteriskToken: AsteriskToken | undefined,
    name: string | PropertyName,
    questionToken: QuestionToken | undefined,
    typeParameters: ReadonlyArray<TypeParameterDeclaration> | undefined,
    parameters: ReadonlyArray<ParameterDeclaration>,
    type: TypeNode | undefined,
    body: Block | undefined,
  ): MethodDeclaration =>
    createMethodDeclaration7(
      modifiers,
      asteriskToken,
      nameOf(name),
      questionToken,
      typeParameters,
      parameters,
      type,
      body,
    ),
  createKeywordTypeNode: <TKind extends KeywordTypeSyntaxKind>(
    kind: TKind,
  ): KeywordTypeNode<TKind> => createKeywordTypeNode(kind),
  createExportSpecifier: (
    isTypeOnly: boolean,
    propertyName: string | ModuleExportName | undefined,
    name: string | ModuleExportName,
  ): ExportSpecifier =>
    createExportSpecifier7(
      isTypeOnly,
      propertyName === undefined ? undefined : nameOf(propertyName),
      nameOf(name),
    ),
  createExportDeclaration: (
    modifiers: ReadonlyArray<ModifierLike> | undefined,
    isTypeOnly: boolean,
    exportClause: NamedExportBindings | undefined,
    moduleSpecifier?: Expression,
    attributes?: ImportAttributes,
  ): ExportDeclaration =>
    createExportDeclaration7(modifiers, isTypeOnly, exportClause, moduleSpecifier, attributes),
  updateMethodDeclaration: (
    node: MethodDeclaration,
    modifiers: ReadonlyArray<ModifierLike> | undefined,
    asteriskToken: AsteriskToken | undefined,
    name: PropertyName,
    questionToken: QuestionToken | undefined,
    typeParameters: ReadonlyArray<TypeParameterDeclaration> | undefined,
    parameters: ReadonlyArray<ParameterDeclaration>,
    type: TypeNode | undefined,
    body: Block | undefined,
  ): MethodDeclaration =>
    updateMethodDeclaration7(
      node,
      modifiers,
      asteriskToken,
      name,
      questionToken,
      typeParameters,
      parameters,
      type,
      body,
    ),
  createEquality: (left: Expression, right: Expression): BinaryExpression =>
    createBinaryExpression(left, SyntaxKind.EqualsEqualsToken, right),
  createAssignment: (left: Expression, right: Expression): BinaryExpression =>
    createBinaryExpression(left, SyntaxKind.EqualsToken, right),
};
