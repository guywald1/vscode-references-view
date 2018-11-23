/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { History } from './history';
import { Model, ReferenceItem, FileItem } from './model';
import { DataProvider, getPreviewChunks } from './provider';
import { EditorHighlights } from './editorHighlights';

export function activate(context: vscode.ExtensionContext) {

    const viewId = 'references-view.tree';
    const history = new History();
    const provider = new DataProvider();

    const view = vscode.window.createTreeView(viewId, {
        treeDataProvider: provider,
        showCollapseAll: true
    });

    // editor highlights
    const editorHighlights = new EditorHighlights();
    vscode.window.onDidChangeActiveTextEditor(editorHighlights.show, editorHighlights, context.subscriptions);
    view.onDidChangeVisibility(e => e.visible ? editorHighlights.show() : editorHighlights.hide(), context.subscriptions);

    // current active model
    let model: Model | undefined;

    const findCommand = async (uri?: vscode.Uri, position?: vscode.Position) => {
        // upon first interaction set the reference list as active
        // which will reveal it
        await vscode.commands.executeCommand('setContext', 'reference-list.isActive', true)

        // remove existing highlights
        editorHighlights.setModel(undefined);
        view.message = undefined;

        let modelCreation: Promise<Model | undefined> | undefined;
        if (uri instanceof vscode.Uri && position instanceof vscode.Position) {
            // trust args if correct'ish
            modelCreation = Model.create(uri, position);

        } else if (vscode.window.activeTextEditor) {
            let editor = vscode.window.activeTextEditor;
            if (editor.document.getWordRangeAtPosition(editor.selection.active)) {
                modelCreation = Model.create(editor.document.uri, editor.selection.active);
            }
        }

        if (!modelCreation) {
            return;
        }

        // the model creation promise is passed to the provider so that the 
        // tree view can indicate loading, for everthing else we need to wait
        // for the model to be resolved
        provider.setModelCreation(modelCreation);
        model = await modelCreation;

        // update context
        vscode.commands.executeCommand('setContext', 'reference-list.hasResult', Boolean(model));

        if (model) {
            // update history
            history.add(model);

            // update editor
            editorHighlights.setModel(model);

            // udate tree
            const selection = model.first();
            if (selection) {
                view.reveal(selection, { select: true, focus: true });
                vscode.commands.executeCommand(`${viewId}.focus`);
            }

            // update message
            if (model.total === 1 && model.items.length === 1) {
                view.message = new vscode.MarkdownString(`${model.total} result in ${model.items.length} file`);
            } else if (model.total === 1) {
                view.message = new vscode.MarkdownString(`${model.total} result in ${model.items.length} files`);
            } else if (model.items.length === 1) {
                view.message = new vscode.MarkdownString(`${model.total} results in ${model.items.length} file`);
            } else {
                view.message = new vscode.MarkdownString(`${model.total} results in ${model.items.length} files`);
            }
        }
    };

    const refindCommand = (id: string) => {
        if (typeof id !== 'string') {
            return;
        }
        let item = history.get(id);
        if (item) {
            return findCommand(item.uri, item.position);
        }
    }

    const refreshCommand = async () => {
        if (model) {
            return findCommand(model.uri, model.position);
        }
    }

    const clearCommand = async () => {
        vscode.commands.executeCommand('setContext', 'reference-list.hasResult', false);
        editorHighlights.setModel(undefined);
        provider.setModelCreation(undefined);

        let message = new vscode.MarkdownString(`To populate this view, open an editor and run the 'Find All References'-command or run a previous search again:\n`)
        message.isTrusted = true;
        for (const item of history) {
            let md = await item.preview;
            if (md) {
                message.appendMarkdown(`* ${md}\n`);
            }
        }
        view.message = message;
    }

    const showRefCommand = (arg?: ReferenceItem | any) => {
        if (arg instanceof ReferenceItem) {
            const { location } = arg;
            vscode.window.showTextDocument(location.uri, {
                selection: location.range.with({ end: location.range.start }),
                preserveFocus: true
            });
        }
    };

    const removeRefCommand = (arg?: ReferenceItem | any) => {
        if (model) {
            const next = model.move(arg, true);
            model.remove(arg);
            editorHighlights.refresh();
            if (next) {
                view.reveal(next, { select: true });
            }
        }
    };

    const focusRefCommand = (fwd: boolean) => {
        if (!model) {
            return;
        }
        const selection = view.selection[0] || model.first();
        const next = model.move(selection, fwd);
        if (next) {
            view.reveal(next, { select: true });
            showRefCommand(next);
        }
    };

    const copyCommand = async (arg?: ReferenceItem | FileItem | Model | any | undefined) => {
        let val = '';
        let stack = [arg];
        while (stack.length > 0) {
            let item = stack.pop();
            if (item instanceof Model) {
                stack.push(...item.items);

            } else if (item instanceof ReferenceItem) {
                let doc = await item.parent.getDocument()
                let chunks = getPreviewChunks(doc, item.location.range, 21, false);
                val += `  ${item.location.range.start.line + 1},${item.location.range.start.character + 1}:${chunks.before + chunks.inside + chunks.after}\n`;

            } else if (item instanceof FileItem) {
                val += `${vscode.workspace.asRelativePath(item.uri)}\n`;
                stack.push(...item.results);
            }
        }
        if (val) {
            await vscode.env.clipboard.writeText(val);
        }
    }

    context.subscriptions.push(
        view,
        vscode.commands.registerCommand('references-view.find', findCommand),
        vscode.commands.registerCommand('references-view.refind', refindCommand),
        vscode.commands.registerCommand('references-view.refresh', refreshCommand),
        vscode.commands.registerCommand('references-view.clear', clearCommand),
        vscode.commands.registerCommand('references-view.show', showRefCommand),
        vscode.commands.registerCommand('references-view.remove', removeRefCommand),
        vscode.commands.registerCommand('references-view.next', () => focusRefCommand(true)),
        vscode.commands.registerCommand('references-view.prev', () => focusRefCommand(false)),
        vscode.commands.registerCommand('references-view.copy', copyCommand),
        vscode.commands.registerCommand('references-view.copyAll', () => copyCommand(model))
    );
}
