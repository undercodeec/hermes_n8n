/* eslint-disable @typescript-eslint/unbound-method -- Methods are inspected as metadata targets, never invoked. */
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';
import { JwtAuthGuard } from './jwt-auth.guard';
import { WebAuthGuard } from '../../auth/web-auth.guard';
import { AuthController } from '../../auth/auth.controller';
import {
  BankAccountsController,
  TransfersController,
} from '../../payments/payments.controller';
import { ConversationsController } from '../../conversations/conversations.controller';
import { MessagesController } from '../../messages/messages.controller';
import { ContactsController } from '../../contacts/contacts.controller';

// Importing Passport's factory elsewhere makes it easy to bypass the mobile
// restriction in JwtAuthGuard. Disallow the factory rather than matching only
// the literal AuthGuard('jwt'), so aliases and alternate quoting are covered.
function passportFactoryImports(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@nestjs/passport'
    ) {
      const bindings = node.importClause?.namedBindings;
      if (
        bindings &&
        (ts.isNamespaceImport(bindings) ||
          bindings.elements.some(
            (element) =>
              (element.propertyName ?? element.name).text === 'AuthGuard',
          ))
      ) {
        violations.push('Passport AuthGuard or namespace import');
      }
    }
    // CommonJS and dynamic imports can conceal the same factory.
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require')) &&
      node.arguments.some(
        (arg) => ts.isStringLiteral(arg) && arg.text === '@nestjs/passport',
      )
    ) {
      violations.push('dynamic/CommonJS Passport import');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') &&
      !/\.(spec|test|d)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe('legacy JWT route architecture', () => {
  it('keeps the Passport guard factory exclusive to the common JWT guard', () => {
    const root = join(__dirname, '../..');
    const commonGuard = join(__dirname, 'jwt-auth.guard.ts');
    const violations = sourceFiles(root)
      .filter((file) => file !== commonGuard)
      .flatMap((file) =>
        passportFactoryImports(readFileSync(file, 'utf8'), file).map(
          (issue) => `${relative(root, file)}: ${issue}`,
        ),
      );
    expect(violations).toEqual([]);
  });

  it('detects renamed, namespace, and CommonJS factory imports without matching comments', () => {
    expect(
      passportFactoryImports(
        'import { AuthGuard as Guard } from \'@nestjs/passport\'; Guard("jwt");',
        'fixture.ts',
      ),
    ).not.toEqual([]);
    expect(
      passportFactoryImports(
        "import * as passport from '@nestjs/passport'; passport.AuthGuard('jwt');",
        'fixture.ts',
      ),
    ).not.toEqual([]);
    expect(
      passportFactoryImports(
        "const { AuthGuard } = require('@nestjs/passport');",
        'fixture.ts',
      ),
    ).not.toEqual([]);
    expect(
      passportFactoryImports(
        "// AuthGuard('jwt')\nimport { PassportModule } from '@nestjs/passport';",
        'fixture.ts',
      ),
    ).toEqual([]);
  });

  it.each([
    ['register', AuthController.prototype.register],
    ['profile', AuthController.prototype.getProfile],
    ['bank accounts', BankAccountsController],
    ['transfers', TransfersController],
    ['conversations', ConversationsController],
    ['messages', MessagesController],
    ['contacts', ContactsController],
  ])('%s uses the common legacy guard', (_name, target) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, target)).toContain(
      JwtAuthGuard,
    );
  });
  it('phone revocation requires a durable web session rather than any JWT', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.revokeAllMobile))
      .toContain(WebAuthGuard);
  });
});
