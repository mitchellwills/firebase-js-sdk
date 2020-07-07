/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  CONSOLE_CAMPAIGN_ANALYTICS_ENABLED,
  CONSOLE_CAMPAIGN_ID,
  CONSOLE_CAMPAIGN_NAME,
  CONSOLE_CAMPAIGN_TIME,
  DEFAULT_SW_PATH,
  DEFAULT_SW_SCOPE,
  DEFAULT_VAPID_KEY,
  TAG
} from '../util/constants';
import {
  CompleteFn,
  ErrorFn,
  NextFn,
  Observer,
  Unsubscribe
} from '@firebase/util';
import {
  ConsoleMessageData,
  MessagePayload,
  MessagePayloadInternal,
  MessageType
} from '../interfaces/message-payload';
import { ERROR_FACTORY, ErrorCode } from '../util/errors';
import { deleteToken, getToken } from '../core/token-management';

import { FirebaseApp } from '@firebase/app-types';
import { FirebaseInternalDependencies } from '../interfaces/internal-dependencies';
import { FirebaseMessaging } from '@firebase/messaging-types';
import { FirebaseService } from '@firebase/app-types/private';
import { externalizePayload } from '../helpers/externalizePayload';
import { isConsoleMessage } from '../helpers/is-console-message';

export class WindowController implements FirebaseMessaging, FirebaseService {
  private vapidKey: string | null = null;
  private swRegistration?: ServiceWorkerRegistration;
  private onMessageCallback: NextFn<object> | Observer<object> | null = null;

  constructor(
    private readonly firebaseDependencies: FirebaseInternalDependencies
  ) {
    navigator.serviceWorker.addEventListener('message', e =>
      this.messageEventListener(e)
    );
  }

  get app(): FirebaseApp {
    return this.firebaseDependencies.app;
  }

  private async messageEventListener(event: MessageEvent): Promise<void> {
    const internalPayload = event.data as MessagePayloadInternal;

    if (!internalPayload.isFirebaseMessaging) {
      return;
    }

    if (
      this.onMessageCallback &&
      internalPayload.messageType === MessageType.PUSH_RECEIVED
    ) {
      this.onMessageCallback(externalizePayload(internalPayload));
    }

    const dataPayload = internalPayload.data;
    if (
      isConsoleMessage(dataPayload) &&
      dataPayload[CONSOLE_CAMPAIGN_ANALYTICS_ENABLED] === '1'
    ) {
      await this.logEvent(internalPayload.messageType!, dataPayload);
    }
  }

  getVapidKey(): string | null {
    return this.vapidKey;
  }

  getSwReg(): ServiceWorkerRegistration | undefined {
    return this.swRegistration;
  }

  async getToken(options?: {
    vapidKey?: string;
    serviceWorkerRegistration?: ServiceWorkerRegistration;
  }): Promise<string> {
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }

    if (Notification.permission !== 'granted') {
      throw ERROR_FACTORY.create(ErrorCode.PERMISSION_BLOCKED);
    }

    await this.updateVapidKey(options?.vapidKey);
    await this.updateSwReg(options?.serviceWorkerRegistration);

    if (!this.swRegistration) {
      console.debug(
        TAG +
          'no sw has been provided explicitly. Attempting to find firebase-messaging-sw.js in default directory.'
      );
      await this.registerDefaultSw();
    }

    return getToken(
      this.firebaseDependencies,
      this.swRegistration!,
      this.vapidKey!
    );
  }

  async updateVapidKey(vapidKey: string | undefined): Promise<void> {
    if (!!this.vapidKey && !!vapidKey && this.vapidKey !== vapidKey) {
      console.debug(
        TAG +
          'newly provided VapidKey is different from previously stored VapidKey.  New VapidKey is overriding.'
      );
      this.vapidKey = vapidKey;
    }

    if (!this.vapidKey && !!vapidKey) {
      this.vapidKey = vapidKey;
    }

    if (!this.vapidKey && !vapidKey) {
      console.debug(
        TAG +
          'no VapidKey is provided. Using the default VapidKey. Note that Push will NOT work in Chrome without a non-default VapidKey.'
      );
      this.vapidKey = DEFAULT_VAPID_KEY;
    }
  }

  async updateSwReg(
    swRegistration: ServiceWorkerRegistration | undefined
  ): Promise<void> {
    if (!swRegistration) {
      return;
    }

    if (!(swRegistration instanceof ServiceWorkerRegistration)) {
      throw ERROR_FACTORY.create(ErrorCode.INVALID_SW_REGISTRATION);
    }

    this.swRegistration = swRegistration;
  }

  private async registerDefaultSw(): Promise<void> {
    try {
      this.swRegistration = await navigator.serviceWorker.register(
        DEFAULT_SW_PATH,
        {
          scope: DEFAULT_SW_SCOPE
        }
      );

      // The timing when browser updates sw when sw has an update is unreliable by my experiment.
      // It leads to version conflict when the SDK upgrades to a newer version in the main page, but
      // sw is stuck with the old version. For example, https://github.com/firebase/firebase-js-sdk/issues/2590
      // The following line reliably updates sw if there was an update.
      this.swRegistration.update().catch(() => {
        /* it is non blocking and we don't care if it failed */
      });
    } catch (e) {
      throw ERROR_FACTORY.create(ErrorCode.FAILED_DEFAULT_REGISTRATION, {
        browserErrorMessage: e.message
      });
    }
  }

  async deleteToken(): Promise<boolean> {
    if (!this.swRegistration) {
      await this.registerDefaultSw();
    }

    return deleteToken(this.firebaseDependencies, this.swRegistration!);
  }

  /**
   * Request permission if it is not currently granted.
   *
   * @return Resolves if the permission was granted, rejects otherwise.
   *
   * @deprecated Use Notification.requestPermission() instead.
   * https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission
   */
  async requestPermission(): Promise<void> {
    if (Notification.permission === 'granted') {
      return;
    }

    const permissionResult = await Notification.requestPermission();
    if (permissionResult === 'granted') {
      return;
    } else if (permissionResult === 'denied') {
      throw ERROR_FACTORY.create(ErrorCode.PERMISSION_BLOCKED);
    } else {
      throw ERROR_FACTORY.create(ErrorCode.PERMISSION_DEFAULT);
    }
  }

  usePublicVapidKey(vapidKey: string): void {
    if (this.vapidKey !== null) {
      throw ERROR_FACTORY.create(ErrorCode.USE_VAPID_KEY_AFTER_GET_TOKEN);
    }

    if (typeof vapidKey !== 'string' || vapidKey.length === 0) {
      throw ERROR_FACTORY.create(ErrorCode.INVALID_VAPID_KEY);
    }

    this.vapidKey = vapidKey;
  }

  useServiceWorker(swRegistration: ServiceWorkerRegistration): void {
    if (!(swRegistration instanceof ServiceWorkerRegistration)) {
      throw ERROR_FACTORY.create(ErrorCode.INVALID_SW_REGISTRATION);
    }

    if (this.swRegistration) {
      throw ERROR_FACTORY.create(ErrorCode.USE_SW_AFTER_GET_TOKEN);
    }

    this.swRegistration = swRegistration;
  }

  /**
   * @param nextOrObserver An observer object or a function triggered on
   * message.
   *
   * @return The unsubscribe function for the observer.
   */
  onMessage(nextOrObserver: NextFn<object> | Observer<object>): Unsubscribe {
    this.onMessageCallback = nextOrObserver;

    return () => {
      this.onMessageCallback = null;
    };
  }

  setBackgroundMessageHandler(): void {
    throw ERROR_FACTORY.create(ErrorCode.AVAILABLE_IN_SW);
  }

  onBackgroundMessage(
    nextOrObserver: NextFn<MessagePayload> | Observer<MessagePayload>,
    error?: ErrorFn,
    completed?: CompleteFn
  ): Unsubscribe {
    throw ERROR_FACTORY.create(ErrorCode.AVAILABLE_IN_SW);
  }

  /**
   * No-op. It was initially designed with token rotation requests from server in mind. However, the plan to implement such feature was abandoned.
   * @deprecated
   */
  onTokenRefresh(): Unsubscribe {
    return () => {};
  }

  private async logEvent(
    messageType: MessageType,
    data: ConsoleMessageData
  ): Promise<void> {
    const eventType = getEventType(messageType);
    const analytics = await this.firebaseDependencies.analyticsProvider.get();
    analytics.logEvent(eventType, {
      /* eslint-disable camelcase */
      message_id: data[CONSOLE_CAMPAIGN_ID],
      message_name: data[CONSOLE_CAMPAIGN_NAME],
      message_time: data[CONSOLE_CAMPAIGN_TIME],
      message_device_time: Math.floor(Date.now() / 1000)
      /* eslint-enable camelcase */
    });
  }
}

function getEventType(messageType: MessageType): string {
  switch (messageType) {
    case MessageType.NOTIFICATION_CLICKED:
      return 'notification_open';
    case MessageType.PUSH_RECEIVED:
      return 'notification_foreground';
    default:
      throw new Error();
  }
}
