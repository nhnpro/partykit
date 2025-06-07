// Polyfill WebSocket status code constants for environments that don't have them
// in order to support libraries that expect standards-compatible WebSocket
// implementations (e.g. PartySocket)

import type {
  Connection,
  ConnectionSetStateFn,
  ConnectionState
} from "./types";

if (!("OPEN" in WebSocket)) {
  const WebSocketStatus = {
    // @ts-expect-error
    CONNECTING: WebSocket.READY_STATE_CONNECTING,
    // @ts-expect-error
    OPEN: WebSocket.READY_STATE_OPEN,
    // @ts-expect-error
    CLOSING: WebSocket.READY_STATE_CLOSING,
    // @ts-expect-error
    CLOSED: WebSocket.READY_STATE_CLOSED
  };

  Object.assign(WebSocket, WebSocketStatus);
  // @ts-expect-error
  Object.assign(WebSocket.prototype, WebSocketStatus);
}

/**
 * Store both platform attachments and user attachments in different namespaces
 */
type ConnectionAttachments = {
  __pk: {
    id: string;
    // TODO: remove this once we have
    // durable object level setState
    server: string;
  };
  __user?: unknown;
};

/**
 * Cache websocket attachments to avoid having to rehydrate them on every property access.
 */
class AttachmentCache {
  #cache = new WeakMap<WebSocket, ConnectionAttachments>();

  get(ws: WebSocket): ConnectionAttachments {
    let attachment = this.#cache.get(ws);
    if (!attachment) {
      attachment = WebSocket.prototype.deserializeAttachment.call(
        ws
      ) as ConnectionAttachments;
      if (attachment !== undefined) {
        this.#cache.set(ws, attachment);
      } else {
        throw new Error(
          "Missing websocket attachment. This is most likely an issue in PartyServer, please open an issue at https://github.com/threepointone/partyserver/issues"
        );
      }
    }

    return attachment;
  }

  set(ws: WebSocket, attachment: ConnectionAttachments) {
    this.#cache.set(ws, attachment);
    WebSocket.prototype.serializeAttachment.call(ws, attachment);
  }
}

const attachments = new AttachmentCache();
const connections = new WeakSet<Connection>();
const isWrapped = (ws: WebSocket): ws is Connection => {
  return connections.has(ws as Connection);
};

/**
 * Wraps a WebSocket with Connection fields that rehydrate the
 * socket attachments lazily only when requested.
 */
export const createLazyConnection = (
  ws: WebSocket | Connection
): Connection => {
  if (isWrapped(ws)) {
    return ws;
  }

  // if state was set on the socket before initializing the connection,
  // capture it here so we can persist it again
  let initialState = undefined;
  if ("state" in ws) {
    initialState = ws.state;
    // biome-ignore lint/performance/noDelete: <explanation>
    delete ws.state;
  }

  const connection = Object.defineProperties(ws, {
    id: {
      get() {
        return attachments.get(ws).__pk.id;
      }
    },
    server: {
      get() {
        return attachments.get(ws).__pk.server;
      }
    },
    socket: {
      get() {
        return ws;
      }
    },
    state: {
      get() {
        return ws.deserializeAttachment() as ConnectionState<unknown>;
      }
    },
    setState: {
      value: function setState<T>(setState: T | ConnectionSetStateFn<T>) {
        let state: T;
        if (setState instanceof Function) {
          state = setState((this as Connection<T>).state);
        } else {
          state = setState;
        }

        ws.serializeAttachment(state);
        return state as ConnectionState<T>;
      }
    },

    deserializeAttachment: {
      value: function deserializeAttachment<T = unknown>() {
        const attachment = attachments.get(ws);
        return (attachment.__user ?? null) as T;
      }
    },

    serializeAttachment: {
      value: function serializeAttachment<T = unknown>(attachment: T) {
        const setting = {
          ...attachments.get(ws),
          __user: attachment ?? null
        };

        attachments.set(ws, setting);
      }
    }
  }) as Connection;

  if (initialState) {
    connection.setState(initialState);
  }

  connections.add(connection);
  return connection;
};

class HibernatingConnectionIterator<T>
  implements IterableIterator<Connection<T>>
{
  private index = 0;
  private sockets: WebSocket[] | undefined;
  constructor(
    private state: DurableObjectState,
    private tag?: string
  ) {}

  [Symbol.iterator](): IterableIterator<Connection<T>> {
    return this;
  }

  next(): IteratorResult<Connection<T>, number | undefined> {
    const sockets =
      // biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
      this.sockets ?? (this.sockets = this.state.getWebSockets(this.tag));

    let socket: WebSocket;
    // biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
    while ((socket = sockets[this.index++])) {
      // only yield open sockets to match non-hibernating behaviour
      if (socket.readyState === WebSocket.READY_STATE_OPEN) {
        const value = createLazyConnection(socket) as Connection<T>;
        return { done: false, value };
      }
    }

    // reached the end of the iteratee
    return { done: true, value: undefined };
  }
}

export interface ConnectionManager {
  getCount(): number;
  getConnection<TState>(id: string): Connection<TState> | undefined;
  getConnections<TState>(tag?: string): IterableIterator<Connection<TState>>;
  accept(
    connection: Connection,
    options: { tags: string[]; server: string }
  ): Connection;
}

/**
 * When not using hibernation, we track active connections manually.
 */
export class InMemoryConnectionManager<TState> implements ConnectionManager {
  #connections: Map<string, Connection> = new Map();
  tags: WeakMap<Connection, string[]> = new WeakMap();

  getCount() {
    return this.#connections.size;
  }

  getConnection<T = TState>(id: string) {
    return this.#connections.get(id) as Connection<T> | undefined;
  }

  *getConnections<T = TState>(tag?: string): IterableIterator<Connection<T>> {
    if (!tag) {
      yield* this.#connections
        .values()
        .filter(
          (c) => c.readyState === WebSocket.READY_STATE_OPEN
        ) as IterableIterator<Connection<T>>;
      return;
    }

    // simulate DurableObjectState.getWebSockets(tag) behaviour
    for (const connection of this.#connections.values()) {
      const connectionTags = this.tags.get(connection) ?? [];
      if (connectionTags.includes(tag)) {
        yield connection as Connection<T>;
      }
    }
  }

  accept(connection: Connection, options: { tags: string[]; server: string }) {
    connection.accept();
    //TODO: if exist connection with same id, disconnect current connection
    if (this.#connections.has(connection.id)) {
      this.#connections.get(connection.id)?.close();
    }

    this.#connections.set(connection.id, connection);
    this.tags.set(connection, [
      // make sure we have id tag
      connection.id,
      ...options.tags.filter((t) => t !== connection.id)
    ]);

    const removeConnection = () => {
      this.#connections.delete(connection.id);
      connection.removeEventListener("close", removeConnection);
      connection.removeEventListener("error", removeConnection);
    };
    connection.addEventListener("close", removeConnection);
    connection.addEventListener("error", removeConnection);

    return connection;
  }
}

/**
 * When opting into hibernation, the platform tracks connections for us.
 */
export class HibernatingConnectionManager<TState> implements ConnectionManager {
  constructor(private controller: DurableObjectState) {}

  getCount() {
    return Number(this.controller.getWebSockets().length);
  }

  getConnection<T = TState>(id: string) {
    // TODO: Should we cache the connections?
    const sockets = this.controller.getWebSockets(id);
    if (sockets.length === 0) return undefined;
    if (sockets.length === 1)
      return createLazyConnection(sockets[0]) as Connection<T>;

    throw new Error(
      `More than one connection found for id ${id}. Did you mean to use getConnections(tag) instead?`
    );
  }

  getConnections<T = TState>(tag?: string | undefined) {
    return new HibernatingConnectionIterator<T>(this.controller, tag);
  }

  accept(connection: Connection, options: { tags: string[]; server: string }) {
    // dedupe tags in case user already provided id tag
    const tags = [
      connection.id,
      ...options.tags.filter((t) => t !== connection.id)
    ];

    // validate tags against documented restrictions
    // shttps://developers.cloudflare.com/durable-objects/api/hibernatable-websockets-api/#state-methods-for-websockets
    if (tags.length > 10) {
      throw new Error(
        "A connection can only have 10 tags, including the default id tag."
      );
    }

    for (const tag of tags) {
      if (typeof tag !== "string") {
        throw new Error(`A connection tag must be a string. Received: ${tag}`);
      }
      if (tag === "") {
        throw new Error("A connection tag must not be an empty string.");
      }
      if (tag.length > 256) {
        throw new Error("A connection tag must not exceed 256 characters");
      }
    }

    this.controller.acceptWebSocket(connection, tags);
    connection.serializeAttachment({
      __pk: {
        id: connection.id,
        server: options.server
      },
      __user: null
    });

    return createLazyConnection(connection);
  }
}
