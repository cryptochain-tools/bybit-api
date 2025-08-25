/* eslint-disable max-len */
/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events';
import WebSocket from 'isomorphic-ws';

import {
  isMessageEvent,
  MessageEventLike,
  WebsocketClientOptions,
  WSClientConfigurableOptions,
  WsMarket,
} from '../types';
import { WsOperation } from '../types/websockets/ws-api';
import { DefaultLogger } from './logger';
import { checkWebCryptoAPISupported } from './webCryptoAPI';
import {
  getNormalisedTopicRequests,
  safeTerminateWs,
  WS_LOGGER_CATEGORY,
  WSConnectedResult,
  WsConnectionStateEnum,
  WsTopicRequest,
  WsTopicRequestOrStringTopic,
} from './websockets';
import { WsStore } from './websockets/WsStore';

type UseTheExceptionEventInstead = never;

interface WSClientEventMap<WsKey extends string> {
  /** Connection opened. If this connection was previously opened and reconnected, expect the reconnected event instead */
  open: (evt: { wsKey: WsKey; event: any }) => void;
  /** Reconnecting a dropped connection */
  reconnect: (evt: { wsKey: WsKey; event: any }) => void;
  /** Successfully reconnected a connection that dropped */
  reconnected: (evt: { wsKey: WsKey; event: any }) => void;
  /** Connection closed */
  close: (evt: { wsKey: WsKey; event: any }) => void;
  /** Received reply to websocket command (e.g. after subscribing to topics) */
  response: (
    response: any & { wsKey: WsKey; isWSAPIResponse?: boolean },
  ) => void;
  /** Received data for topic */
  update: (response: any & { wsKey: WsKey }) => void;
  /**
   * See for more information: https://github.com/tiagosiebler/bybit-api/issues/413
   * @deprecated Use the 'exception' event instead. The 'error' event had the unintended consequence of throwing an unhandled promise rejection.
   */
  error: UseTheExceptionEventInstead;
  /**
   * Exception from ws client OR custom listeners (e.g. if you throw inside your event handler)
   */
  exception: (
    response: any & { wsKey: WsKey; isWSAPIResponse?: boolean },
  ) => void;
  /** Confirmation that a connection successfully authenticated */
  authenticated: (event: {
    wsKey: WsKey;
    event: any;
    isWSAPIResponse?: boolean;
  }) => void;
}

// Type safety for on and emit handlers: https://stackoverflow.com/a/61609010/880837
export interface BaseWebsocketClient<
  TWSKey extends string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-unused-vars
  TWSRequestEvent extends object,
> {
  on<U extends keyof WSClientEventMap<TWSKey>>(
    event: U,
    listener: WSClientEventMap<TWSKey>[U],
  ): this;

  emit<U extends keyof WSClientEventMap<TWSKey>>(
    event: U,
    ...args: Parameters<WSClientEventMap<TWSKey>[U]>
  ): boolean;
}

export interface EmittableEvent<TEvent = any> {
  eventType: 'response' | 'update' | 'exception' | 'authenticated';
  event: TEvent;
  isWSAPIResponse?: boolean;
}

/**
 * A midflight WS request event (e.g. subscribe to these topics).
 *
 * - requestKey: unique identifier for this request, if available. Can be anything as a string.
 * - requestEvent: the raw request, as an object, that will be sent on the ws connection. This may contain multiple topics/requests in one object, if the exchange supports it.
 */
export interface MidflightWsRequestEvent<TEvent = object> {
  requestKey: string;
  requestEvent: TEvent;
}

type TopicsPendingSubscriptionsResolver<TWSRequestEvent extends object> = (
  requests: TWSRequestEvent,
) => void;

type TopicsPendingSubscriptionsRejector<TWSRequestEvent extends object> = (
  requests: TWSRequestEvent,
  reason: string | object,
) => void;

interface WsKeyPendingTopicSubscriptions<TWSRequestEvent extends object> {
  requestData: TWSRequestEvent;
  resolver: TopicsPendingSubscriptionsResolver<TWSRequestEvent>;
  rejector: TopicsPendingSubscriptionsRejector<TWSRequestEvent>;
}

/**
 * Base WebSocket abstraction layer. Handles connections, tracking each connection as a unique "WS Key"
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export abstract class BaseWebsocketClient<
  /**
   * The WS connections supported by the client, each identified by a unique primary key
   */
  TWSKey extends string,
  TWSRequestEvent extends object,
> extends EventEmitter {
  /**
   * State store to track a list of topics (topic requests) we are expected to be subscribed to if reconnected
   */
  private wsStore: WsStore<TWSKey, WsTopicRequest<string>>;

  public logger: typeof DefaultLogger;

  protected options: WebsocketClientOptions;

  private wsApiRequestId: number = 0;

  private timeOffsetMs: number = 0;

  /**
   * A nested wsKey->request key store.
   * pendingTopicSubscriptionRequests[wsKey][requestKey] = WsKeyPendingTopicSubscriptions<TWSRequestEvent>
   */
  private pendingTopicSubscriptionRequests: Record<
    string,
    Record<string, undefined | WsKeyPendingTopicSubscriptions<TWSRequestEvent>>
  > = {};

  constructor(
    options?: WSClientConfigurableOptions,
    logger?: typeof DefaultLogger,
  ) {
    super();

    this.logger = logger || DefaultLogger;
    this.wsStore = new WsStore(this.logger);

    this.options = {
      // Some defaults:
      testnet: false,
      demoTrading: false,

      // Connect to V5 by default, if not defined by the user
      market: 'v5',

      pongTimeout: 1000,
      pingInterval: 10000,
      reconnectTimeout: 500,
      recvWindow: 5000,

      // Calls to subscribeV5() are wrapped in a promise, allowing you to await a subscription request.
      // Note: due to internal complexity, it's only recommended if you connect before subscribing.
      promiseSubscribeRequests: false,

      // Automatically send an authentication op/request after a connection opens, for private connections.
      authPrivateConnectionsOnConnect: true,
      // Individual requests do not require a signature, so this is disabled.
      authPrivateRequests: false,

      ...options,
    };

    // Check Web Crypto API support when credentials are provided and no custom sign function is used
    if (
      this.options.key &&
      this.options.secret &&
      !this.options.customSignMessageFn
    ) {
      checkWebCryptoAPISupported();
    }
  }

  /**
   * Return true if this wsKey connection should automatically authenticate immediately after connecting
   */
  protected abstract isAuthOnConnectWsKey(wsKey: TWSKey): boolean;

  protected abstract sendPingEvent(wsKey: TWSKey, ws: WebSocket): void;

  protected abstract sendPongEvent(wsKey: TWSKey, ws: WebSocket): void;

  protected abstract isWsPing(data: any): boolean;

  protected abstract isWsPong(data: any): boolean;

  protected abstract getWsAuthRequestEvent(wsKey: TWSKey): Promise<object>;

  protected abstract isPrivateTopicRequest(
    request: WsTopicRequest<string>,
    wsKey: TWSKey,
  ): boolean;

  protected abstract getPrivateWSKeys(): TWSKey[];

  protected abstract getWsUrl(wsKey: TWSKey): Promise<string>;

  protected abstract getMaxTopicsPerSubscribeEvent(
    wsKey: TWSKey,
  ): number | null;

  /**
   * @returns one or more correctly structured request events for performing a operations over WS. This can vary per exchange spec.
   */
  protected abstract getWsRequestEvents(
    market: WsMarket,
    operation: WsOperation,
    requests: WsTopicRequest<string>[],
    wsKey: TWSKey,
  ): Promise<MidflightWsRequestEvent<TWSRequestEvent>[]>;

  /**
   * Abstraction called to sort ws events into emittable event types (response to a request, data update, etc)
   */
  protected abstract resolveEmittableEvents(
    wsKey: TWSKey,
    event: MessageEventLike,
  ): EmittableEvent[];

  /**
   * Request connection of all dependent (public & private) websockets, instead of waiting for automatic connection by library
   */
  protected abstract connectAll(): Promise<WSConnectedResult | undefined>[];

  protected isPrivateWsKey(wsKey: TWSKey): boolean {
    return this.getPrivateWSKeys().includes(wsKey);
  }

  /** Returns auto-incrementing request ID, used to track promise references for async requests */
  protected getNewRequestId(): string {
    return `${++this.wsApiRequestId}`;
  }

  protected abstract sendWSAPIRequest(
    wsKey: TWSKey,
    channel: string,
    params?: any,
  ): Promise<unknown>;

  protected abstract sendWSAPIRequest(
    wsKey: TWSKey,
    channel: string,
    params: any,
  ): Promise<unknown>;

  public getTimeOffsetMs() {
    return this.timeOffsetMs;
  }

  public setTimeOffsetMs(newOffset: number) {
    this.timeOffsetMs = newOffset;
  }

  private getWsKeyPendingSubscriptionStore(wsKey: TWSKey) {
    if (!this.pendingTopicSubscriptionRequests[wsKey]) {
      this.pendingTopicSubscriptionRequests[wsKey] = {};
    }

    return this.pendingTopicSubscriptionRequests[wsKey]!;
  }

  protected upsertPendingTopicSubscribeRequests(
    wsKey: TWSKey,
    requestData: MidflightWsRequestEvent<TWSRequestEvent>,
  ) {
    // a unique identifier for this subscription request (e.g. csv of topics, or request id, etc)
    const requestKey = requestData.requestKey;

    // Should not be possible to see a requestKey collision in the current design, since the req ID increments automatically with every request, so this should never be true, but just in case a future mistake happens...

    const pendingSubReqs = this.getWsKeyPendingSubscriptionStore(wsKey);
    if (pendingSubReqs[requestKey]) {
      throw new Error(
        'Implementation error: attempted to upsert pending topics with duplicate request ID!',
      );
    }

    return new Promise(
      (
        resolver: TopicsPendingSubscriptionsResolver<TWSRequestEvent>,
        rejector: TopicsPendingSubscriptionsRejector<TWSRequestEvent>,
      ) => {
        const pendingSubReqs = this.getWsKeyPendingSubscriptionStore(wsKey);
        pendingSubReqs[requestKey] = {
          requestData: requestData.requestEvent,
          resolver,
          rejector,
        };
      },
    );
  }

  protected removeTopicPendingSubscription(wsKey: TWSKey, requestKey: string) {
    const pendingSubReqs = this.getWsKeyPendingSubscriptionStore(wsKey);
    delete pendingSubReqs[requestKey];
  }

  private clearTopicsPendingSubscriptions(
    wsKey: TWSKey,
    rejectAll: boolean,
    rejectReason: string,
  ) {
    if (rejectAll) {
      const pendingSubReqs = this.getWsKeyPendingSubscriptionStore(wsKey);

      for (const requestKey in pendingSubReqs) {
        const request = pendingSubReqs[requestKey];
        this.logger.trace(
          `clearTopicsPendingSubscriptions(${wsKey}, ${rejectAll}, ${rejectReason}, ${requestKey}): rejecting promise for: ${JSON.stringify(request?.requestData || {})}`,
        );
        request?.rejector(request.requestData, rejectReason);
      }
    }

    this.pendingTopicSubscriptionRequests[wsKey] = {};
  }

  /**
   * Resolve/reject the promise for a midflight request.
   *
   * This will typically execute before the event is emitted.
   */
  protected updatePendingTopicSubscriptionStatus(
    wsKey: TWSKey,
    requestKey: string,
    msg: object,
    isTopicSubscriptionSuccessEvent: boolean,
  ) {
    const wsKeyPendingRequests = this.getWsKeyPendingSubscriptionStore(wsKey);
    if (!wsKeyPendingRequests) {
      return;
    }

    const pendingSubscriptionRequest = wsKeyPendingRequests[requestKey];
    if (!pendingSubscriptionRequest) {
      return;
    }

    if (isTopicSubscriptionSuccessEvent) {
      pendingSubscriptionRequest.resolver(
        pendingSubscriptionRequest.requestData,
      );
    } else {
      this.logger.trace(
        `updatePendingTopicSubscriptionStatus.reject(${wsKey}, ${requestKey}, ${msg}, ${isTopicSubscriptionSuccessEvent}): `,
        msg,
      );
      try {
        pendingSubscriptionRequest.rejector(
          pendingSubscriptionRequest.requestData,
          msg,
        );
      } catch (e) {
        console.error('Exception rejecting promise: ', e);
      }
    }

    this.removeTopicPendingSubscription(wsKey, requestKey);
  }

  /**
   * Don't call directly! Use subscribe() instead!
   *
   * Subscribe to one or more topics on a WS connection (identified by WS Key).
   *
   * - Topics are automatically cached
   * - Connections are automatically opened, if not yet connected
   * - Authentication is automatically handled
   * - Topics are automatically resubscribed to, if something happens to the connection, unless you call unsubsribeTopicsForWsKey(topics, key).
   *
   * @param wsRequests array of topics to subscribe to
   * @param wsKey ws key referring to the ws connection these topics should be subscribed on
   */
  protected async subscribeTopicsForWsKey(
    wsTopicRequests: WsTopicRequestOrStringTopic<string>[],
    wsKey: TWSKey,
  ) {
    const normalisedTopicRequests = getNormalisedTopicRequests(wsTopicRequests);

    // Store topics, so future automation (post-auth, post-reconnect) has everything needed to resubscribe automatically
    for (const topic of normalisedTopicRequests) {
      this.wsStore.addTopic(wsKey, topic);
    }

    const isConnected = this.wsStore.isConnectionState(
      wsKey,
      WsConnectionStateEnum.CONNECTED,
    );

    const isConnectionInProgress =
      this.wsStore.isConnectionAttemptInProgress(wsKey);

    // start connection process if it hasn't yet begun. Topics are automatically subscribed to on-connect
    if (!isConnected && !isConnectionInProgress) {
      return this.connect(wsKey);
    }

    // Subscribe should happen automatically once connected, nothing to do here after topics are added to wsStore.
    if (!isConnected) {
      /**
       * Are we in the process of connection? Nothing to send yet.
       */
      this.logger.trace(
        'WS not connected - requests queued for retry once connected.',
        {
          ...WS_LOGGER_CATEGORY,
          wsKey,
          wsTopicRequests,
        },
      );
      return isConnectionInProgress;
    }

    // We're connected. Check if auth is needed and if already authenticated
    const isPrivateConnection = this.isPrivateWsKey(wsKey);
    const isAuthenticated = this.wsStore.get(wsKey)?.isAuthenticated;
    if (isPrivateConnection && !isAuthenticated) {
      /**
       * If not authenticated yet and auth is required, don't request topics yet.
       *
       * Auth should already automatically be in progress, so no action needed from here. Topics will automatically subscribe post-auth success.
       */
      return false;
    }

    // Finally, request subscription to topics if the connection is healthy and ready
    return this.requestSubscribeTopics(wsKey, normalisedTopicRequests);
  }

  protected async unsubscribeTopicsForWsKey(
    wsTopicRequests: WsTopicRequestOrStringTopic<string>[],
    wsKey: TWSKey,
  ): Promise<unknown> {
    const normalisedTopicRequests = getNormalisedTopicRequests(wsTopicRequests);

    // Store topics, so future automation (post-auth, post-reconnect) has everything needed to resubscribe automatically
    for (const topic of normalisedTopicRequests) {
      this.wsStore.deleteTopic(wsKey, topic);
    }

    const isConnected = this.wsStore.isConnectionState(
      wsKey,
      WsConnectionStateEnum.CONNECTED,
    );

    // If not connected, don't need to do anything.
    // Removing the topic from the store is enough to stop it from being resubscribed to on reconnect.
    if (!isConnected) {
      return;
    }

    // We're connected. Check if auth is needed and if already authenticated
    const isPrivateConnection = this.isPrivateWsKey(wsKey);
    const isAuthenticated = this.wsStore.get(wsKey)?.isAuthenticated;
    if (isPrivateConnection && !isAuthenticated) {
      /**
       * If not authenticated yet and auth is required, don't need to do anything.
       * We don't subscribe to topics until auth is complete anyway.
       */
      return;
    }

    // Finally, request subscription to topics if the connection is healthy and ready
    return this.requestUnsubscribeTopics(wsKey, normalisedTopicRequests);
  }

  /**
   * Splits topic requests into two groups, public & private topic requests
   */
  private sortTopicRequestsIntoPublicPrivate(
    wsTopicRequests: WsTopicRequest<string>[],
    wsKey: TWSKey,
  ): {
    publicReqs: WsTopicRequest<string>[];
    privateReqs: WsTopicRequest<string>[];
  } {
    const publicTopicRequests: WsTopicRequest<string>[] = [];
    const privateTopicRequests: WsTopicRequest<string>[] = [];

    for (const topic of wsTopicRequests) {
      if (this.isPrivateTopicRequest(topic, wsKey)) {
        privateTopicRequests.push(topic);
      } else {
        publicTopicRequests.push(topic);
      }
    }

    return {
      publicReqs: publicTopicRequests,
      privateReqs: privateTopicRequests,
    };
  }

  /** Get the WsStore that tracks websockets & topics */
  public getWsStore(): WsStore<TWSKey, WsTopicRequest<string>> {
    return this.wsStore;
  }

  public close(wsKey: TWSKey, force?: boolean) {
    this.logger.info('Closing connection', { ...WS_LOGGER_CATEGORY, wsKey });
    this.setWsState(wsKey, WsConnectionStateEnum.CLOSING);
    this.clearTimers(wsKey);

    const ws = this.getWs(wsKey);
    ws?.close();
    if (force) {
      safeTerminateWs(ws, false);
    }
  }

  public closeAll(force?: boolean) {
    const keys = this.wsStore.getKeys();

    this.logger.info(`Closing all ws connections: ${keys}`);
    keys.forEach((key: TWSKey) => {
      this.close(key, force);
    });
  }

  public isConnected(wsKey: TWSKey): boolean {
    return this.wsStore.isConnectionState(
      wsKey,
      WsConnectionStateEnum.CONNECTED,
    );
  }

  /**
   * Request connection to a specific websocket, instead of waiting for automatic connection.
   */
  public async connect(
    wsKey: TWSKey,
    customUrl?: string | undefined,
    throwOnError?: boolean,
  ): Promise<WSConnectedResult | undefined> {
    try {
      if (this.wsStore.isWsOpen(wsKey)) {
        this.logger.error(
          'Refused to connect to ws with existing active connection',
          { ...WS_LOGGER_CATEGORY, wsKey },
        );
        return { wsKey };
      }

      if (
        this.wsStore.isConnectionState(wsKey, WsConnectionStateEnum.CONNECTING)
      ) {
        this.logger.error(
          'Refused to connect to ws, connection attempt already active',
          { ...WS_LOGGER_CATEGORY, wsKey },
        );
        return this.wsStore.getConnectionInProgressPromise(wsKey)?.promise;
      }

      if (
        !this.wsStore.getConnectionState(wsKey) ||
        this.wsStore.isConnectionState(wsKey, WsConnectionStateEnum.INITIAL)
      ) {
        this.setWsState(wsKey, WsConnectionStateEnum.CONNECTING);
      }

      if (!this.wsStore.getConnectionInProgressPromise(wsKey)) {
        this.wsStore.createConnectionInProgressPromise(wsKey, false);
      }

      const url = customUrl || (await this.getWsUrl(wsKey));
      const ws = this.connectToWsUrl(url, wsKey);

      this.wsStore.setWs(wsKey, ws);

      return this.wsStore.getConnectionInProgressPromise(wsKey)?.promise;
    } catch (err) {
      this.parseWsError('Connection failed', err, wsKey);
      this.reconnectWithDelay(wsKey, this.options.reconnectTimeout!);

      if (throwOnError) {
        throw err;
      }
    }
  }

  private connectToWsUrl(url: string, wsKey: TWSKey): WebSocket {
    this.logger.trace(`Opening WS connection to URL: ${url}`, {
      ...WS_LOGGER_CATEGORY,
      wsKey,
    });

    const agent = this.options.requestOptions?.agent;
    const ws = new WebSocket(url, undefined, agent ? { agent } : undefined);

    ws.onopen = (event: any) => this.onWsOpen(event, wsKey);
    ws.onmessage = (event: any) => this.onWsMessage(event, wsKey, ws);
    ws.onerror = (event: any) =>
      this.parseWsError('Websocket onWsError', event, wsKey);
    ws.onclose = (event: any) => this.onWsClose(event, wsKey);

    ws.wsKey = wsKey;

    return ws;
  }

  private parseWsError(context: string, error: any, wsKey: TWSKey) {
    if (!error.message) {
      this.logger.error(`${context} due to unexpected error: `, error);
      this.emit('response', { ...error, wsKey });
      this.emit('exception', { ...error, wsKey });
      return;
    }

    switch (error.message) {
      case 'Unexpected server response: 401':
        this.logger.error(`${context} due to 401 authorization failure.`, {
          ...WS_LOGGER_CATEGORY,
          wsKey,
        });
        break;

      default:
        if (
          this.wsStore.getConnectionState(wsKey) !==
          WsConnectionStateEnum.CLOSING
        ) {
          this.logger.error(
            `${context} due to unexpected response error: "${
              error?.msg || error?.message || error
            }"`,
            { ...WS_LOGGER_CATEGORY, wsKey, error },
          );
          this.executeReconnectableClose(wsKey, 'unhandled onWsError');
        } else {
          this.logger.info(
            `${wsKey} socket forcefully closed. Will not reconnect.`,
          );
        }
        break;
    }

    this.logger.error(`parseWsError(${context}, ${error}, ${wsKey}) `, error);

    this.emit('response', { ...error, wsKey });
    this.emit('exception', { ...error, wsKey });
  }

  /** Get a signature, build the auth request and send it */
  private async sendAuthRequest(wsKey: TWSKey): Promise<unknown> {
    try {
      this.logger.trace('Sending auth request...', {
        ...WS_LOGGER_CATEGORY,
        wsKey,
      });

      await this.assertIsConnected(wsKey);

      if (!this.wsStore.getAuthenticationInProgressPromise(wsKey)) {
        this.wsStore.createAuthenticationInProgressPromise(wsKey, false);
      }

      const request = await this.getWsAuthRequestEvent(wsKey);

      // console.log('ws auth req', request);

      this.tryWsSend(wsKey, JSON.stringify(request));

      return this.wsStore.getAuthenticationInProgressPromise(wsKey)?.promise;
    } catch (e) {
      this.logger.trace(e, { ...WS_LOGGER_CATEGORY, wsKey });
    }
  }

  private reconnectWithDelay(wsKey: TWSKey, connectionDelayMs: number) {
    this.clearTimers(wsKey);

    if (!this.wsStore.isConnectionAttemptInProgress(wsKey)) {
      this.setWsState(wsKey, WsConnectionStateEnum.RECONNECTING);
    }

    this.logger.info('Reconnecting to websocket with delay...', {
      ...WS_LOGGER_CATEGORY,
      wsKey,
      connectionDelayMs,
    });

    if (this.wsStore.get(wsKey)?.activeReconnectTimer) {
      this.clearReconnectTimer(wsKey);
    }

    this.wsStore.get(wsKey, true).activeReconnectTimer = setTimeout(() => {
      this.logger.info('Reconnecting to websocket now', {
        ...WS_LOGGER_CATEGORY,
        wsKey,
      });
      this.clearReconnectTimer(wsKey);
      this.connect(wsKey);
    }, connectionDelayMs);
  }

  private ping(wsKey: TWSKey) {
    if (this.wsStore.get(wsKey, true).activePongTimer) {
      return;
    }

    this.clearPongTimer(wsKey);

    this.logger.trace('Sending ping', { ...WS_LOGGER_CATEGORY, wsKey });
    const ws = this.wsStore.get(wsKey, true).ws;

    if (!ws) {
      this.logger.error(
        `Unable to send ping for wsKey "${wsKey}" - no connection found`,
      );
      return;
    }
    this.sendPingEvent(wsKey, ws);

    this.wsStore.get(wsKey, true).activePongTimer = setTimeout(
      () => this.executeReconnectableClose(wsKey, 'Pong timeout'),
      this.options.pongTimeout,
    );
  }

  /**
   * Closes a connection, if it's even open. If open, this will trigger a reconnect asynchronously.
   * If closed, trigger a reconnect immediately
   */
  private executeReconnectableClose(wsKey: TWSKey, reason: string) {
    this.logger.info(`${reason} - closing socket to reconnect`, {
      ...WS_LOGGER_CATEGORY,
      wsKey,
      reason,
    });

    const wasOpen = this.wsStore.isWsOpen(wsKey);

    this.clearPingTimer(wsKey);
    this.clearPongTimer(wsKey);

    const ws = this.getWs(wsKey);

    if (ws) {
      ws.close();
      safeTerminateWs(ws, false);
    }

    if (!wasOpen) {
      this.logger.info(
        `${reason} - socket already closed - trigger immediate reconnect`,
        {
          ...WS_LOGGER_CATEGORY,
          wsKey,
          reason,
        },
      );
      this.reconnectWithDelay(wsKey, this.options.reconnectTimeout);
    }
  }

  private clearTimers(wsKey: TWSKey) {
    this.clearPingTimer(wsKey);
    this.clearPongTimer(wsKey);
    this.clearReconnectTimer(wsKey);
  }

  // Send a ping at intervals
  private clearPingTimer(wsKey: TWSKey) {
    const wsState = this.wsStore.get(wsKey);
    if (wsState?.activePingTimer) {
      clearInterval(wsState.activePingTimer);
      wsState.activePingTimer = undefined;
    }
  }

  // Expect a pong within a time limit
  private clearPongTimer(wsKey: TWSKey) {
    const wsState = this.wsStore.get(wsKey);
    if (wsState?.activePongTimer) {
      clearTimeout(wsState.activePongTimer);
      wsState.activePongTimer = undefined;
      // this.logger.trace(`Cleared pong timeout for "${wsKey}"`);
    } else {
      // this.logger.trace(`No active pong timer for "${wsKey}"`);
    }
  }

  private clearReconnectTimer(wsKey: TWSKey) {
    const wsState = this.wsStore.get(wsKey);
    if (wsState?.activeReconnectTimer) {
      clearTimeout(wsState.activeReconnectTimer);
      wsState.activeReconnectTimer = undefined;
    }
  }

  /**
   * Returns a list of string events that can be individually sent upstream to complete subscribing/unsubscribing/etc to these topics
   *
   * If events are an object, these should be stringified (`return JSON.stringify(event);`)
   * Each event returned by this will be sent one at a time
   *
   * Events are automatically split into smaller batches, by this method, if needed.
   */
  protected async getWsOperationEventsForTopics(
    topics: WsTopicRequest<string>[],
    wsKey: TWSKey,
    operation: WsOperation,
  ): Promise<MidflightWsRequestEvent<TWSRequestEvent>[]> {
    if (!topics.length) {
      return [];
    }

    // Events that are ready to send (usually stringified JSON)
    const requestEvents: MidflightWsRequestEvent<TWSRequestEvent>[] = [];
    const market: WsMarket = 'all';

    const maxTopicsPerEvent = this.getMaxTopicsPerSubscribeEvent(wsKey);
    if (
      maxTopicsPerEvent &&
      maxTopicsPerEvent !== null &&
      topics.length > maxTopicsPerEvent
    ) {
      for (let i = 0; i < topics.length; i += maxTopicsPerEvent) {
        const batch = topics.slice(i, i + maxTopicsPerEvent);
        const subscribeRequestEvents = await this.getWsRequestEvents(
          market,
          operation,
          batch,
          wsKey,
        );

        requestEvents.push(...subscribeRequestEvents);
      }

      return requestEvents;
    }

    const subscribeRequestEvents = await this.getWsRequestEvents(
      market,
      operation,
      topics,
      wsKey,
    );

    return subscribeRequestEvents;
  }

  /**
   * Simply builds and sends subscribe events for a list of topics for a ws key
   *
   * @private Use the `subscribe(topics)` or `subscribeTopicsForWsKey(topics, wsKey)` method to subscribe to topics.
   */
  private async requestSubscribeTopics(
    wsKey: TWSKey,
    wsTopicRequests: WsTopicRequest<string>[],
  ) {
    if (!wsTopicRequests.length) {
      return;
    }

    // Automatically splits requests into smaller batches, if needed
    const subscribeWsMessages = await this.getWsOperationEventsForTopics(
      wsTopicRequests,
      wsKey,
      'subscribe',
    );

    this.logger.trace(
      `Subscribing to ${wsTopicRequests.length} "${wsKey}" topics in ${subscribeWsMessages.length} batches.`, // Events: "${JSON.stringify(topics)}"
    );

    // console.log(`batches: `, JSON.stringify(subscribeWsMessages, null, 2));

    const promises: Promise<TWSRequestEvent>[] = [];

    for (const midflightRequest of subscribeWsMessages) {
      const wsMessage = midflightRequest.requestEvent;

      if (this.options.promiseSubscribeRequests) {
        promises.push(
          this.upsertPendingTopicSubscribeRequests(wsKey, midflightRequest),
        );
      }

      this.logger.trace(
        `Sending batch via message: "${JSON.stringify(wsMessage)}"`,
      );
      this.tryWsSend(wsKey, JSON.stringify(wsMessage));
    }

    this.logger.trace(
      `Finished subscribing to ${wsTopicRequests.length} "${wsKey}" topics in ${subscribeWsMessages.length} batches.`,
    );

    return Promise.all(promises);
  }

  /**
   * Simply builds and sends unsubscribe events for a list of topics for a ws key
   *
   * @private Use the `unsubscribe(topics)` method to unsubscribe from topics. Send WS message to unsubscribe from topics.
   */
  private async requestUnsubscribeTopics(
    wsKey: TWSKey,
    wsTopicRequests: WsTopicRequest<string>[],
  ) {
    if (!wsTopicRequests.length) {
      return;
    }

    const subscribeWsMessages = await this.getWsOperationEventsForTopics(
      wsTopicRequests,
      wsKey,
      'unsubscribe',
    );

    this.logger.trace(
      `Unsubscribing to ${wsTopicRequests.length} "${wsKey}" topics in ${subscribeWsMessages.length} batches. Events: "${JSON.stringify(wsTopicRequests)}"`,
    );

    const promises: Promise<TWSRequestEvent>[] = [];

    for (const midflightRequest of subscribeWsMessages) {
      const wsMessage = midflightRequest.requestEvent;

      if (this.options.promiseSubscribeRequests) {
        promises.push(
          this.upsertPendingTopicSubscribeRequests(wsKey, midflightRequest),
        );
      }

      this.logger.trace(`Sending batch via message: "${wsMessage}"`);
      this.tryWsSend(wsKey, JSON.stringify(wsMessage));
    }

    this.logger.trace(
      `Finished unsubscribing to ${wsTopicRequests.length} "${wsKey}" topics in ${subscribeWsMessages.length} batches.`,
    );

    return Promise.all(promises);
  }

  /**
   * Try sending a string event on a WS connection (identified by the WS Key)
   */
  public tryWsSend(
    wsKey: TWSKey,
    wsMessage: string,
    throwExceptions?: boolean,
  ) {
    try {
      this.logger.trace('Sending upstream ws message: ', {
        ...WS_LOGGER_CATEGORY,
        wsMessage,
        wsKey,
      });
      if (!wsKey) {
        throw new Error(
          'Cannot send message due to no known websocket for this wsKey',
        );
      }
      const ws = this.getWs(wsKey);
      if (!ws) {
        throw new Error(
          `${wsKey} socket not connected yet, call "connectAll()" first then try again when the "open" event arrives`,
        );
      }
      ws.send(wsMessage);
    } catch (e) {
      this.logger.error('Failed to send WS message', {
        ...WS_LOGGER_CATEGORY,
        wsMessage,
        wsKey,
        exception: e,
      });
      if (throwExceptions) {
        throw e;
      }
    }
  }

  private async onWsOpen(event: any, wsKey: TWSKey) {
    const isFreshConnectionAttempt = this.wsStore.isConnectionState(
      wsKey,
      WsConnectionStateEnum.CONNECTING,
    );

    const isReconnectionAttempt = this.wsStore.isConnectionState(
      wsKey,
      WsConnectionStateEnum.RECONNECTING,
    );

    if (isFreshConnectionAttempt) {
      this.logger.info('Websocket connected', {
        ...WS_LOGGER_CATEGORY,
        wsKey,
        testnet: this.options.testnet === true,
        market: this.options.market,
      });

      this.emit('open', { wsKey, event });
    } else if (isReconnectionAttempt) {
      this.logger.info('Websocket reconnected', {
        ...WS_LOGGER_CATEGORY,
        wsKey,
        testnet: this.options.testnet === true,
        market: this.options.market,
      });

      this.emit('reconnected', { wsKey, event });
    }

    this.setWsState(wsKey, WsConnectionStateEnum.CONNECTED);

    this.logger.trace('Enabled ping timer', { ...WS_LOGGER_CATEGORY, wsKey });
    this.wsStore.get(wsKey, true)!.activePingTimer = setInterval(
      () => this.ping(wsKey),
      this.options.pingInterval,
    );

    // Resolve & cleanup deferred "connection attempt in progress" promise
    try {
      const connectionInProgressPromise =
        this.wsStore.getConnectionInProgressPromise(wsKey);
      if (connectionInProgressPromise?.resolve) {
        connectionInProgressPromise.resolve({
          wsKey,
        });
      }
    } catch (e) {
      this.logger.error(
        'Exception trying to resolve "connectionInProgress" promise',
        e,
      );
    }

    // Remove before continuing, in case there's more requests queued
    this.wsStore.removeConnectingInProgressPromise(wsKey);

    // Reconnect to topics known before it connected
    const { privateReqs, publicReqs } = this.sortTopicRequestsIntoPublicPrivate(
      [...this.wsStore.getTopics(wsKey)],
      wsKey,
    );

    // Request sub to public topics, if any
    try {
      await this.requestSubscribeTopics(wsKey, publicReqs);
    } catch (e) {
      this.logger.error(
        `onWsOpen(): exception in public requestSubscribeTopics(${wsKey}): `,
        publicReqs,
        e,
      );
    }

    // Request sub to private topics, if auth on connect isn't needed
    // Else, this is automatic after authentication is successfully confirmed
    if (!this.options.authPrivateConnectionsOnConnect) {
      try {
        this.requestSubscribeTopics(wsKey, privateReqs);
      } catch (e) {
        this.logger.error(
          `onWsOpen(): exception in private requestSubscribeTopics(${wsKey}: `,
          privateReqs,
          e,
        );
      }
    }

    // Some websockets require an auth packet to be sent after opening the connection
    if (
      this.isAuthOnConnectWsKey(wsKey) &&
      this.options.authPrivateConnectionsOnConnect
    ) {
      await this.sendAuthRequest(wsKey);
    }
  }

  /**
   * Handle subscription to private topics _after_ authentication successfully completes asynchronously.
   *
   * Only used for exchanges that require auth before sending private topic subscription requests
   */
  private onWsAuthenticated(wsKey: TWSKey, event: unknown) {
    const wsState = this.wsStore.get(wsKey, true);
    wsState.isAuthenticated = true;

    // Resolve & cleanup deferred "connection attempt in progress" promise
    try {
      const inProgressPromise =
        this.wsStore.getAuthenticationInProgressPromise(wsKey);

      if (inProgressPromise?.resolve) {
        inProgressPromise.resolve({
          wsKey,
          event,
        });
      }
    } catch (e) {
      this.logger.error(
        'Exception trying to resolve "connectionInProgress" promise',
        e,
      );
    }

    // Remove before continuing, in case there's more requests queued
    this.wsStore.removeAuthenticationInProgressPromise(wsKey);

    if (this.options.authPrivateConnectionsOnConnect) {
      const topics = [...this.wsStore.getTopics(wsKey)];
      const privateTopics = topics.filter((topic) =>
        this.isPrivateTopicRequest(topic, wsKey),
      );

      if (privateTopics.length) {
        this.subscribeTopicsForWsKey(privateTopics, wsKey);
      }
    }
  }

  private onWsMessage(event: unknown, wsKey: TWSKey, ws: WebSocket) {
    try {
      // console.log('onMessageRaw: ', (event as any).data);
      // any message can clear the pong timer - wouldn't get a message if the ws wasn't working
      this.clearPongTimer(wsKey);

      if (this.isWsPong(event)) {
        this.logger.trace('Received pong', {
          ...WS_LOGGER_CATEGORY,
          wsKey,
          event: (event as any)?.data,
        });
        return;
      }

      if (this.isWsPing(event)) {
        this.logger.trace('Received ping', {
          ...WS_LOGGER_CATEGORY,
          wsKey,
          event,
        });
        this.sendPongEvent(wsKey, ws);
        return;
      }

      if (isMessageEvent(event)) {
        const data = event.data;
        const dataType = event.type;

        const emittableEvents = this.resolveEmittableEvents(wsKey, event);

        if (!emittableEvents.length) {
          // console.log(`raw event: `, { data, dataType, emittableEvents });
          this.logger.error(
            'Unhandled/unrecognised ws event message - returned no emittable data',
            {
              ...WS_LOGGER_CATEGORY,
              message: data || 'no message',
              dataType,
              event,
              wsKey,
            },
          );

          return this.emit('update', { ...event, wsKey });
        }

        for (const emittable of emittableEvents) {
          if (this.isWsPong(emittable)) {
            this.logger.trace('Received pong2', {
              ...WS_LOGGER_CATEGORY,
              wsKey,
              data,
            });
            continue;
          }
          const emittableFinalEvent = {
            ...emittable.event,
            wsKey,
            isWSAPIResponse: emittable.isWSAPIResponse,
          };

          if (emittable.eventType === 'authenticated') {
            this.logger.trace('Successfully authenticated', {
              ...WS_LOGGER_CATEGORY,
              wsKey,
              emittable,
            });
            this.emit(emittable.eventType, emittableFinalEvent);
            this.onWsAuthenticated(wsKey, emittable.event);
            continue;
          }

          // this.logger.trace(
          //   `onWsMessage().emit(${emittable.eventType})`,
          //   emittableFinalEvent,
          // );
          try {
            this.emit(emittable.eventType, emittableFinalEvent);
          } catch (e) {
            this.logger.error(
              `Exception in onWsMessage().emit(${emittable.eventType}) handler:`,
              e,
            );
          }
          // this.logger.trace(
          //   `onWsMessage().emit(${emittable.eventType}).done()`,
          //   emittableFinalEvent,
          // );
        }

        return;
      }

      this.logger.error(
        'Unhandled/unrecognised ws event message - unexpected message format',
        {
          ...WS_LOGGER_CATEGORY,
          message: event || 'no message',
          event,
          wsKey,
        },
      );
    } catch (e) {
      this.logger.error('Failed to parse ws event message', {
        ...WS_LOGGER_CATEGORY,
        error: e,
        event,
        wsKey,
      });
    }
  }

  private onWsClose(event: unknown, wsKey: TWSKey) {
    this.logger.info('Websocket connection closed', {
      ...WS_LOGGER_CATEGORY,
      wsKey,
    });

    const wsState = this.wsStore.get(wsKey, true);
    wsState.isAuthenticated = false;

    if (
      this.wsStore.getConnectionState(wsKey) !== WsConnectionStateEnum.CLOSING
    ) {
      this.logger.trace(
        `onWsClose(${wsKey}): rejecting all deferred promises...`,
      );
      // clean up any pending promises for this connection
      this.getWsStore().rejectAllDeferredPromises(
        wsKey,
        'connection lost, reconnecting',
      );

      this.clearTopicsPendingSubscriptions(wsKey, true, 'WS Closed');

      this.setWsState(wsKey, WsConnectionStateEnum.INITIAL);

      this.reconnectWithDelay(wsKey, this.options.reconnectTimeout!);
      this.emit('reconnect', { wsKey, event });
    } else {
      // clean up any pending promises for this connection
      this.logger.trace(
        `onWsClose(${wsKey}): rejecting all deferred promises...`,
      );
      this.getWsStore().rejectAllDeferredPromises(wsKey, 'disconnected');
      this.setWsState(wsKey, WsConnectionStateEnum.INITIAL);

      // This was an intentional close, delete all state for this connection, as if it never existed:
      this.wsStore.delete(wsKey);

      this.emit('close', { wsKey, event });
    }
  }

  private getWs(wsKey: TWSKey) {
    return this.wsStore.getWs(wsKey);
  }

  private setWsState(wsKey: TWSKey, state: WsConnectionStateEnum) {
    this.wsStore.setConnectionState(wsKey, state);
  }

  /**
   * Promise-driven method to assert that a ws has successfully connected (will await until connection is open)
   */
  public async assertIsConnected(wsKey: TWSKey): Promise<unknown> {
    const isConnected = this.getWsStore().isConnectionState(
      wsKey,
      WsConnectionStateEnum.CONNECTED,
    );

    if (!isConnected) {
      const inProgressPromise =
        this.getWsStore().getConnectionInProgressPromise(wsKey);

      // Already in progress? Await shared promise and retry
      if (inProgressPromise) {
        this.logger.trace('assertIsConnected(): awaiting...');
        await inProgressPromise.promise;
        this.logger.trace('assertIsConnected(): connected!');
        return inProgressPromise.promise;
      }

      // Start connection, it should automatically store/return a promise.
      this.logger.trace('assertIsConnected(): connecting...');

      await this.connect(wsKey);

      this.logger.trace('assertIsConnected(): newly connected!');
    }
  }

  /**
   * Promise-driven method to assert that a ws has been successfully authenticated (will await until auth is confirmed)
   */
  public async assertIsAuthenticated(wsKey: TWSKey): Promise<unknown> {
    const isConnected = this.getWsStore().isConnectionState(
      wsKey,
      WsConnectionStateEnum.CONNECTED,
    );

    if (!isConnected) {
      this.logger.trace('assertIsAuthenticated(): connecting...');
      await this.assertIsConnected(wsKey);
    }

    const inProgressPromise =
      this.getWsStore().getAuthenticationInProgressPromise(wsKey);

    // Already in progress? Await shared promise and retry
    if (inProgressPromise) {
      this.logger.trace('assertIsAuthenticated(): awaiting...');
      await inProgressPromise.promise;
      this.logger.trace('assertIsAuthenticated(): authenticated!');
      return;
    }

    const isAuthenticated = this.wsStore.get(wsKey)?.isAuthenticated;
    if (isAuthenticated) {
      this.logger.trace('assertIsAuthenticated(): ok');
      return;
    }

    // Start authentication, it should automatically store/return a promise.
    this.logger.trace('assertIsAuthenticated(): authenticating...');

    await this.sendAuthRequest(wsKey);

    this.logger.trace('assertIsAuthenticated(): newly authenticated!');
  }
}
