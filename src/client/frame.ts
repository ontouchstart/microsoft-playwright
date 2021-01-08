/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { assert } from '../utils/utils';
import * as channels from '../protocol/channels';
import { ChannelOwner } from './channelOwner';
import { ElementHandle, convertSelectOptionValues, convertInputFiles } from './elementHandle';
import { assertMaxArguments, JSHandle, serializeArgument, parseResult } from './jsHandle';
import * as fs from 'fs';
import * as network from './network';
import * as util from 'util';
import { Page } from './page';
import { EventEmitter } from 'events';
import { Waiter } from './waiter';
import { Events } from './events';
import { LifecycleEvent, URLMatch, SelectOption, SelectOptionOptions, FilePayload, WaitForFunctionOptions, kLifecycleEvents } from './types';
import { urlMatches } from './clientHelper';
import * as api from '../../types/types';
import * as structs from '../../types/structs';

const fsReadFileAsync = util.promisify(fs.readFile.bind(fs));

export type WaitForNavigationOptions = {
  timeout?: number,
  waitUntil?: LifecycleEvent,
  url?: URLMatch,
};

export class Frame extends ChannelOwner<channels.FrameChannel, channels.FrameInitializer> implements api.Frame {
  _eventEmitter: EventEmitter;
  _loadStates: Set<LifecycleEvent>;
  _parentFrame: Frame | null = null;
  _url = '';
  _name = '';
  _detached = false;
  _childFrames = new Set<Frame>();
  _page: Page | undefined;

  static from(frame: channels.FrameChannel): Frame {
    return (frame as any)._object;
  }

  static fromNullable(frame: channels.FrameChannel | undefined): Frame | null {
    return frame ? Frame.from(frame) : null;
  }

  constructor(parent: ChannelOwner, type: string, guid: string, initializer: channels.FrameInitializer) {
    super(parent, type, guid, initializer);
    this._eventEmitter = new EventEmitter();
    this._eventEmitter.setMaxListeners(0);
    this._parentFrame = Frame.fromNullable(initializer.parentFrame);
    if (this._parentFrame)
      this._parentFrame._childFrames.add(this);
    this._name = initializer.name;
    this._url = initializer.url;
    this._loadStates = new Set(initializer.loadStates);
    this._channel.on('loadstate', event => {
      if (event.add) {
        this._loadStates.add(event.add);
        this._eventEmitter.emit('loadstate', event.add);
      }
      if (event.remove)
        this._loadStates.delete(event.remove);
    });
    this._channel.on('navigated', event => {
      this._url = event.url;
      this._name = event.name;
      this._eventEmitter.emit('navigated', event);
      if (!event.error && this._page)
        this._page.emit(Events.Page.FrameNavigated, this);
    });
  }

  private _apiName(method: string) {
    return this._page!._isPageCall ? 'page.' + method : 'frame.' + method;
  }

  page(): Page {
    return this._page!;
  }

  async goto(url: string, options: channels.FrameGotoOptions = {}): Promise<network.Response | null> {
    return this._wrapApiCall(this._apiName('goto'), async () => {
      const waitUntil = verifyLoadState('waitUntil', options.waitUntil === undefined ? 'load' : options.waitUntil);
      return network.Response.fromNullable((await this._channel.goto({ url, ...options, waitUntil })).response);
    });
  }

  private _setupNavigationWaiter(options: { timeout?: number }): Waiter {
    const waiter = new Waiter();
    waiter.rejectOnEvent(this._page!, Events.Page.Close, new Error('Navigation failed because page was closed!'));
    waiter.rejectOnEvent(this._page!, Events.Page.Crash, new Error('Navigation failed because page crashed!'));
    waiter.rejectOnEvent<Frame>(this._page!, Events.Page.FrameDetached, new Error('Navigating frame was detached!'), frame => frame === this);
    const timeout = this._page!._timeoutSettings.navigationTimeout(options);
    waiter.rejectOnTimeout(timeout, `Timeout ${timeout}ms exceeded.`);

    return waiter;
  }

  async waitForNavigation(options: WaitForNavigationOptions = {}): Promise<network.Response | null> {
    return this._wrapApiCall(this._apiName('waitForNavigation'), async () => {
      const waitUntil = verifyLoadState('waitUntil', options.waitUntil === undefined ? 'load' : options.waitUntil);
      const waiter = this._setupNavigationWaiter(options);

      const toUrl = typeof options.url === 'string' ? ` to "${options.url}"` : '';
      waiter.log(`waiting for navigation${toUrl} until "${waitUntil}"`);

      const navigatedEvent = await waiter.waitForEvent<channels.FrameNavigatedEvent>(this._eventEmitter, 'navigated', event => {
        // Any failed navigation results in a rejection.
        if (event.error)
          return true;
        waiter.log(`  navigated to "${event.url}"`);
        return urlMatches(event.url, options.url);
      });
      if (navigatedEvent.error) {
        const e = new Error(navigatedEvent.error);
        e.stack = '';
        await waiter.waitForPromise(Promise.reject(e));
      }

      if (!this._loadStates.has(waitUntil)) {
        await waiter.waitForEvent<LifecycleEvent>(this._eventEmitter, 'loadstate', s => {
          waiter.log(`  "${s}" event fired`);
          return s === waitUntil;
        });
      }

      const request = navigatedEvent.newDocument ? network.Request.fromNullable(navigatedEvent.newDocument.request) : null;
      const response = request ? await waiter.waitForPromise(request._finalRequest().response()) : null;
      waiter.dispose();
      return response;
    });
  }

  async waitForLoadState(state: LifecycleEvent = 'load', options: { timeout?: number } = {}): Promise<void> {
    state = verifyLoadState('state', state);
    if (this._loadStates.has(state))
      return;
    return this._wrapApiCall(this._apiName('waitForLoadState'), async () => {
      const waiter = this._setupNavigationWaiter(options);
      await waiter.waitForEvent<LifecycleEvent>(this._eventEmitter, 'loadstate', s => {
        waiter.log(`  "${s}" event fired`);
        return s === state;
      });
      waiter.dispose();
    });
  }

  async frameElement(): Promise<ElementHandle> {
    return this._wrapApiCall(this._apiName('frameElement'), async () => {
      return ElementHandle.from((await this._channel.frameElement()).element);
    });
  }

  async evaluateHandle<R, Arg>(pageFunction: structs.PageFunction<Arg, R>, arg?: Arg): Promise<structs.SmartHandle<R>> {
    assertMaxArguments(arguments.length, 2);
    return this._wrapApiCall(this._apiName('evaluateHandle'), async () => {
      const result = await this._channel.evaluateExpressionHandle({ expression: String(pageFunction), isFunction: typeof pageFunction === 'function', arg: serializeArgument(arg) });
      return JSHandle.from(result.handle) as any as structs.SmartHandle<R>;
    });
  }

  async _evaluateHandleInUtility<R, Arg>(pageFunction: structs.PageFunction<Arg, R>, arg: Arg): Promise<structs.SmartHandle<R>>;
  async _evaluateHandleInUtility<R>(pageFunction: structs.PageFunction<void, R>, arg?: any): Promise<structs.SmartHandle<R>>;
  async _evaluateHandleInUtility<R, Arg>(pageFunction: structs.PageFunction<Arg, R>, arg?: Arg): Promise<structs.SmartHandle<R>> {
    assertMaxArguments(arguments.length, 2);
    return this._wrapApiCall(this._apiName('_evaluateHandleInUtility'), async () => {
      const result = await this._channel.evaluateExpressionHandle({ expression: String(pageFunction), isFunction: typeof pageFunction === 'function', arg: serializeArgument(arg), world: 'utility' });
      return JSHandle.from(result.handle) as any as structs.SmartHandle<R>;
    });
  }

  async evaluate<R, Arg>(pageFunction: structs.PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    assertMaxArguments(arguments.length, 2);
    return this._wrapApiCall(this._apiName('evaluate'), async () => {
      const result = await this._channel.evaluateExpression({ expression: String(pageFunction), isFunction: typeof pageFunction === 'function', arg: serializeArgument(arg) });
      return parseResult(result.value);
    });
  }

  async _evaluateInUtility<R, Arg>(pageFunction: structs.PageFunction<Arg, R>, arg: Arg): Promise<R>;
  async _evaluateInUtility<R>(pageFunction: structs.PageFunction<void, R>, arg?: any): Promise<R>;
  async _evaluateInUtility<R, Arg>(pageFunction: structs.PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    assertMaxArguments(arguments.length, 2);
    return this._wrapApiCall(this._apiName('evaluate'), async () => {
      const result = await this._channel.evaluateExpression({ expression: String(pageFunction), isFunction: typeof pageFunction === 'function', arg: serializeArgument(arg), world: 'utility' });
      return parseResult(result.value);
    });
  }

  async $(selector: string): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
    return this._wrapApiCall(this._apiName('$'), async () => {
      const result = await this._channel.querySelector({ selector });
      return ElementHandle.fromNullable(result.element) as ElementHandle<SVGElement | HTMLElement> | null;
    });
  }

  waitForSelector(selector: string, options: channels.FrameWaitForSelectorOptions & { state: 'attached' | 'visible' }): Promise<ElementHandle<SVGElement | HTMLElement>>;
  waitForSelector(selector: string, options?: channels.FrameWaitForSelectorOptions): Promise<ElementHandle<SVGElement | HTMLElement> | null>;
  async waitForSelector(selector: string, options: channels.FrameWaitForSelectorOptions = {}): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
    return this._wrapApiCall(this._apiName('waitForSelector'), async () => {
      if ((options as any).visibility)
        throw new Error('options.visibility is not supported, did you mean options.state?');
      if ((options as any).waitFor && (options as any).waitFor !== 'visible')
        throw new Error('options.waitFor is not supported, did you mean options.state?');
      const result = await this._channel.waitForSelector({ selector, ...options });
      return ElementHandle.fromNullable(result.element) as ElementHandle<SVGElement | HTMLElement> | null;
    });
  }

  async dispatchEvent(selector: string, type: string, eventInit?: any, options: channels.FrameDispatchEventOptions = {}): Promise<void> {
    return this._wrapApiCall(this._apiName('dispatchEvent'), async () => {
      await this._channel.dispatchEvent({ selector, type, eventInit: serializeArgument(eventInit), ...options });
    });
  }

  async $eval<R, Arg>(selector: string, pageFunction: structs.PageFunctionOn<Element, Arg, R>, arg?: Arg): Promise<R> {
    assertMaxArguments(arguments.length, 3);
    return this._wrapApiCall(this._apiName('$eval'), async () => {
      const result = await this._channel.evalOnSelector({ selector, expression: String(pageFunction), isFunction: typeof pageFunction === 'function', arg: serializeArgument(arg) });
      return parseResult(result.value);
    });
  }

  async $$eval<R, Arg>(selector: string, pageFunction: structs.PageFunctionOn<Element[], Arg, R>, arg?: Arg): Promise<R> {
    assertMaxArguments(arguments.length, 3);
    return this._wrapApiCall(this._apiName('$$eval'), async () => {
      const result = await this._channel.evalOnSelectorAll({ selector, expression: String(pageFunction), isFunction: typeof pageFunction === 'function', arg: serializeArgument(arg) });
      return parseResult(result.value);
    });
  }

  async $$(selector: string): Promise<ElementHandle<SVGElement | HTMLElement>[]> {
    return this._wrapApiCall(this._apiName('$$'), async () => {
      const result = await this._channel.querySelectorAll({ selector });
      return result.elements.map(e => ElementHandle.from(e) as ElementHandle<SVGElement | HTMLElement>);
    });
  }

  async content(): Promise<string> {
    return this._wrapApiCall(this._apiName('content'), async () => {
      return (await this._channel.content()).value;
    });
  }

  async setContent(html: string, options: channels.FrameSetContentOptions = {}): Promise<void> {
    return this._wrapApiCall(this._apiName('setContent'), async () => {
      const waitUntil = verifyLoadState('waitUntil', options.waitUntil === undefined ? 'load' : options.waitUntil);
      await this._channel.setContent({ html, ...options, waitUntil });
    });
  }

  name(): string {
    return this._name || '';
  }

  url(): string {
    return this._url;
  }

  parentFrame(): Frame | null {
    return this._parentFrame;
  }

  childFrames(): Frame[] {
    return Array.from(this._childFrames);
  }

  isDetached(): boolean {
    return this._detached;
  }

  async addScriptTag(params: { url?: string, path?: string, content?: string, type?: string }): Promise<ElementHandle> {
    return this._wrapApiCall(this._apiName('addScriptTag'), async () => {
      const copy = { ...params };
      if (copy.path) {
        copy.content = (await fsReadFileAsync(copy.path)).toString();
        copy.content += '//# sourceURL=' + copy.path.replace(/\n/g, '');
      }
      return ElementHandle.from((await this._channel.addScriptTag({ ...copy })).element);
    });
  }

  async addStyleTag(params: { url?: string; path?: string; content?: string; }): Promise<ElementHandle> {
    return this._wrapApiCall(this._apiName('addStyleTag'), async () => {
      const copy = { ...params };
      if (copy.path) {
        copy.content = (await fsReadFileAsync(copy.path)).toString();
        copy.content += '/*# sourceURL=' + copy.path.replace(/\n/g, '') + '*/';
      }
      return ElementHandle.from((await this._channel.addStyleTag({ ...copy })).element);
    });
  }

  async click(selector: string, options: channels.FrameClickOptions = {}) {
    return this._wrapApiCall(this._apiName('click'), async () => {
      return await this._channel.click({ selector, ...options });
    });
  }

  async dblclick(selector: string, options: channels.FrameDblclickOptions = {}) {
    return this._wrapApiCall(this._apiName('dblclick'), async () => {
      return await this._channel.dblclick({ selector, ...options });
    });
  }

  async tap(selector: string, options: channels.FrameTapOptions = {}) {
    return this._wrapApiCall(this._apiName('tap'), async () => {
      return await this._channel.tap({ selector, ...options });
    });
  }

  async fill(selector: string, value: string, options: channels.FrameFillOptions = {}) {
    return this._wrapApiCall(this._apiName('fill'), async () => {
      return await this._channel.fill({ selector, value, ...options });
    });
  }

  async focus(selector: string, options: channels.FrameFocusOptions = {}) {
    return this._wrapApiCall(this._apiName('focus'), async () => {
      await this._channel.focus({ selector, ...options });
    });
  }

  async textContent(selector: string, options: channels.FrameTextContentOptions = {}): Promise<null|string> {
    return this._wrapApiCall(this._apiName('textContent'), async () => {
      const value = (await this._channel.textContent({ selector, ...options })).value;
      return value === undefined ? null : value;
    });
  }

  async innerText(selector: string, options: channels.FrameInnerTextOptions = {}): Promise<string> {
    return this._wrapApiCall(this._apiName('innerText'), async () => {
      return (await this._channel.innerText({ selector, ...options })).value;
    });
  }

  async innerHTML(selector: string, options: channels.FrameInnerHTMLOptions = {}): Promise<string> {
    return this._wrapApiCall(this._apiName('innerHTML'), async () => {
      return (await this._channel.innerHTML({ selector, ...options })).value;
    });
  }

  async getAttribute(selector: string, name: string, options: channels.FrameGetAttributeOptions = {}): Promise<string | null> {
    return this._wrapApiCall(this._apiName('getAttribute'), async () => {
      const value = (await this._channel.getAttribute({ selector, name, ...options })).value;
      return value === undefined ? null : value;
    });
  }

  async isDisabled(selector: string, options: channels.FrameIsDisabledOptions = {}): Promise<boolean> {
    return this._wrapApiCall(this._apiName('isDisabled'), async () => {
      return (await this._channel.isDisabled({ selector, ...options })).value;
    });
  }

  async isEditable(selector: string, options: channels.FrameIsEditableOptions = {}): Promise<boolean> {
    return this._wrapApiCall(this._apiName('isEditable'), async () => {
      return (await this._channel.isEditable({ selector, ...options })).value;
    });
  }

  async isEnabled(selector: string, options: channels.FrameIsEnabledOptions = {}): Promise<boolean> {
    return this._wrapApiCall(this._apiName('isEnabled'), async () => {
      return (await this._channel.isEnabled({ selector, ...options })).value;
    });
  }

  async isHidden(selector: string, options: channels.FrameIsHiddenOptions = {}): Promise<boolean> {
    return this._wrapApiCall(this._apiName('isHidden'), async () => {
      return (await this._channel.isHidden({ selector, ...options })).value;
    });
  }

  async isVisible(selector: string, options: channels.FrameIsVisibleOptions = {}): Promise<boolean> {
    return this._wrapApiCall(this._apiName('isVisible'), async () => {
      return (await this._channel.isVisible({ selector, ...options })).value;
    });
  }

  async hover(selector: string, options: channels.FrameHoverOptions = {}) {
    return this._wrapApiCall(this._apiName('hover'), async () => {
      await this._channel.hover({ selector, ...options });
    });
  }

  async selectOption(selector: string, values: string | api.ElementHandle | SelectOption | string[] | api.ElementHandle[] | SelectOption[] | null, options: SelectOptionOptions = {}): Promise<string[]> {
    return this._wrapApiCall(this._apiName('selectOption'), async () => {
      return (await this._channel.selectOption({ selector, ...convertSelectOptionValues(values), ...options })).values;
    });
  }

  async setInputFiles(selector: string, files: string | FilePayload | string[] | FilePayload[], options: channels.FrameSetInputFilesOptions = {}): Promise<void> {
    return this._wrapApiCall(this._apiName('setInputFiles'), async () => {
      await this._channel.setInputFiles({ selector, files: await convertInputFiles(files), ...options });
    });
  }

  async type(selector: string, text: string, options: channels.FrameTypeOptions = {}) {
    return this._wrapApiCall(this._apiName('type'), async () => {
      await this._channel.type({ selector, text, ...options });
    });
  }

  async press(selector: string, key: string, options: channels.FramePressOptions = {}) {
    return this._wrapApiCall(this._apiName('press'), async () => {
      await this._channel.press({ selector, key, ...options });
    });
  }

  async check(selector: string, options: channels.FrameCheckOptions = {}) {
    return this._wrapApiCall(this._apiName('check'), async () => {
      await this._channel.check({ selector, ...options });
    });
  }

  async uncheck(selector: string, options: channels.FrameUncheckOptions = {}) {
    return this._wrapApiCall(this._apiName('uncheck'), async () => {
      await this._channel.uncheck({ selector, ...options });
    });
  }

  async waitForTimeout(timeout: number) {
    await new Promise(fulfill => setTimeout(fulfill, timeout));
  }

  async waitForFunction<R, Arg>(pageFunction: structs.PageFunction<Arg, R>, arg?: Arg, options: WaitForFunctionOptions = {}): Promise<structs.SmartHandle<R>> {
    return this._wrapApiCall(this._apiName('waitForFunction'), async () => {
      if (typeof options.polling === 'string')
        assert(options.polling === 'raf', 'Unknown polling option: ' + options.polling);
      const result = await this._channel.waitForFunction({
        ...options,
        pollingInterval: options.polling === 'raf' ? undefined : options.polling,
        expression: String(pageFunction),
        isFunction: typeof pageFunction === 'function',
        arg: serializeArgument(arg),
      });
      return JSHandle.from(result.handle) as any as structs.SmartHandle<R>;
    });
  }

  async title(): Promise<string> {
    return this._wrapApiCall(this._apiName('title'), async () => {
      return (await this._channel.title()).value;
    });
  }

  // TODO: remove once playwright-cli does not use this one anymore.
  async _extendInjectedScript<Arg>(source: string, arg?: Arg): Promise<JSHandle> {
    const result = await this._channel.extendInjectedScript({ source, arg: serializeArgument(arg) });
    return JSHandle.from(result.handle);
  }
}

export function verifyLoadState(name: string, waitUntil: LifecycleEvent): LifecycleEvent {
  if (waitUntil as unknown === 'networkidle0')
    waitUntil = 'networkidle';
  if (!kLifecycleEvents.has(waitUntil))
    throw new Error(`${name}: expected one of (load|domcontentloaded|networkidle)`);
  return waitUntil;
}
