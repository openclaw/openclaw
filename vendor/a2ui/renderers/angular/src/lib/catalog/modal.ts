/*
 Copyright 2025 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

import { Component, signal, viewChild, ElementRef, effect } from '@angular/core';
import { DynamicComponent } from '../rendering/dynamic-component';
import { Types } from '@a2ui/lit/0.8';
import { Renderer } from '../rendering';

@Component({
  selector: 'a2ui-modal',
  imports: [Renderer],
  template: `
    @if (showDialog()) {
      <dialog #dialog [class]="theme.components.Modal.backdrop" (click)="handleDialogClick($event)">
        <section [class]="theme.components.Modal.element" [style]="theme.additionalStyles?.Modal">
          <div class="controls">
            <button (click)="closeDialog()">
              <span class="g-icon">close</span>
            </button>
          </div>

          <ng-container
            a2ui-renderer
            [surfaceId]="surfaceId()!"
            [component]="component().properties.contentChild"
          />
        </section>
      </dialog>
    } @else {
      <section (click)="showDialog.set(true)">
        <ng-container
          a2ui-renderer
          [surfaceId]="surfaceId()!"
          [component]="component().properties.entryPointChild"
        />
      </section>
    }
  `,
  styles: `
    dialog {
      padding: 0;
      border: none;
      background: none;

      & section {
        & .controls {
          display: flex;
          justify-content: end;
          margin-bottom: 4px;

          & button {
            padding: 0;
            background: none;
            width: 20px;
            height: 20px;
            pointer: cursor;
            border: none;
            cursor: pointer;
          }
        }
      }
    }
  `,
})
export class Modal extends DynamicComponent<Types.ModalNode> {
  protected readonly showDialog = signal(false);
  protected readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    super();

    effect(() => {
      const dialog = this.dialog();

      if (dialog && !dialog.nativeElement.open) {
        dialog.nativeElement.showModal();
      }
    });
  }

  protected handleDialogClick(event: MouseEvent) {
    if (event.target instanceof HTMLDialogElement) {
      this.closeDialog();
    }
  }

  protected closeDialog() {
    const dialog = this.dialog();

    if (!dialog) {
      return;
    }

    if (!dialog.nativeElement.open) {
      dialog.nativeElement.close();
    }

    this.showDialog.set(false);
  }
}
