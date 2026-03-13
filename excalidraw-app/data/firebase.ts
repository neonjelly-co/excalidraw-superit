import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { FILE_CACHE_MAX_AGE_SEC } from "../app_constants";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// private
// -----------------------------------------------------------------------------

const env = import.meta.env as ImportMetaEnv &
  Record<string, string | undefined>;

const PERSISTENCE_API_BASE_URL_GET =
  env.VITE_APP_PERSISTENCE_API_URL ||
  env.VITE_APP_BACKEND_V2_GET_URL ||
  env.VITE_APP_BACKEND_V2_POST_URL ||
  "";

const PERSISTENCE_API_BASE_URL_POST =
  env.VITE_APP_PERSISTENCE_API_URL ||
  env.VITE_APP_BACKEND_V2_POST_URL ||
  env.VITE_APP_BACKEND_V2_GET_URL ||
  "";

const SCENES_API_BASE_URL_GET =
  env.VITE_APP_PG_SCENES_API_URL ||
  env.VITE_APP_SCENES_API_URL ||
  PERSISTENCE_API_BASE_URL_GET;

const SCENES_API_BASE_URL_POST =
  env.VITE_APP_PG_SCENES_API_URL ||
  env.VITE_APP_SCENES_API_URL ||
  PERSISTENCE_API_BASE_URL_POST;

const FILES_API_BASE_URL_GET =
  env.VITE_APP_FILES_API_URL ||
  env.VITE_APP_STORAGE_API_URL ||
  PERSISTENCE_API_BASE_URL_GET;

const FILES_API_BASE_URL_POST =
  env.VITE_APP_FILES_API_URL ||
  env.VITE_APP_STORAGE_API_URL ||
  PERSISTENCE_API_BASE_URL_POST;

const createPersistenceHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};

  const pgHost = env.VITE_APP_PG_HOST;
  const pgPort = env.VITE_APP_PG_PORT;
  const pgDatabase = env.VITE_APP_PG_DATABASE;
  const pgUser = env.VITE_APP_PG_USER;
  const pgPassword = env.VITE_APP_PG_PASSWORD;
  const pgSchema = env.VITE_APP_PG_SCHEMA;
  const pgSslMode = env.VITE_APP_PG_SSLMODE;

  if (pgHost) headers["x-pg-host"] = pgHost;
  if (pgPort) headers["x-pg-port"] = pgPort;
  if (pgDatabase) headers["x-pg-database"] = pgDatabase;
  if (pgUser) headers["x-pg-user"] = pgUser;
  if (pgPassword) headers["x-pg-password"] = pgPassword;
  if (pgSchema) headers["x-pg-schema"] = pgSchema;
  if (pgSslMode) headers["x-pg-sslmode"] = pgSslMode;

  return headers;
};

const ensureApiBaseUrl = (baseUrl: string, label: string) => {
  if (!baseUrl) {
    throw new Error(
      `${label} is not configured. Set one of: VITE_APP_PERSISTENCE_API_URL, VITE_APP_BACKEND_V2_GET_URL, VITE_APP_BACKEND_V2_POST_URL, VITE_APP_SCENES_API_URL, VITE_APP_FILES_API_URL, VITE_APP_PG_SCENES_API_URL, VITE_APP_STORAGE_API_URL.`,
    );
  }
};

const joinUrl = (baseUrl: string, path: string) => {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedPath}`;
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
};

const fromBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const getStorageObjectPath = (prefix: string, id: string) => {
  const normalizedPrefix = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return `${normalizedPrefix}/${id}`;
};

// -----------------------------------------------------------------------------

export const loadFirebaseStorage = async (): Promise<any> => {
  return {
    kind: "filesystem-api",
    baseUrl: FILES_API_BASE_URL_POST,
  };
};

type StoredScene = {
  sceneVersion: number;
  iv: string;
  ciphertext: string;
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: new Uint8Array(encryptedBuffer), iv };
};

const decryptElements = async (
  data: StoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = fromBase64(data.ciphertext);
  const iv = fromBase64(data.iv);

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

const getSceneFromStore = async (
  roomId: string,
): Promise<StoredScene | null> => {
  ensureApiBaseUrl(
    SCENES_API_BASE_URL_GET,
    "Scenes GET API base URL (VITE_APP_BACKEND_V2_GET_URL)",
  );

  const response = await fetch(
    joinUrl(SCENES_API_BASE_URL_GET, `scenes/${encodeURIComponent(roomId)}`),
    {
      method: "GET",
      headers: {
        ...createPersistenceHeaders(),
      },
    },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Failed loading scene from PostgreSQL store (${response.status}).`,
    );
  }

  return (await response.json()) as StoredScene;
};

const saveSceneToStore = async (
  roomId: string,
  scene: StoredScene,
  expectedSceneVersion: number | null,
): Promise<{ scene: StoredScene; conflicted: boolean }> => {
  ensureApiBaseUrl(
    SCENES_API_BASE_URL_POST,
    "Scenes write API base URL (VITE_APP_BACKEND_V2_POST_URL)",
  );

  const response = await fetch(
    joinUrl(SCENES_API_BASE_URL_POST, `scenes/${encodeURIComponent(roomId)}`),
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...createPersistenceHeaders(),
      },
      body: JSON.stringify({
        ...scene,
        expectedSceneVersion,
      }),
    },
  );

  if (response.status === 409) {
    return { scene, conflicted: true };
  }

  if (!response.ok) {
    throw new Error(
      `Failed saving scene to PostgreSQL store (${response.status}).`,
    );
  }

  return { scene: (await response.json()) as StoredScene, conflicted: false };
};

class SceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return SceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return SceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  ensureApiBaseUrl(
    FILES_API_BASE_URL_POST,
    "Files write API base URL (VITE_APP_BACKEND_V2_POST_URL)",
  );

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const objectPath = getStorageObjectPath(prefix, id);
        const response = await fetch(
          joinUrl(
            FILES_API_BASE_URL_POST,
            `files/${encodeURIComponent(objectPath)}`,
          ),
          {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "cache-control": `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
              ...createPersistenceHeaders(),
            },
            body: new Blob([new Uint8Array(buffer)]),
          },
        );
        if (!response.ok) {
          throw new Error(`Failed saving file '${id}' (${response.status})`);
        }
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const createFirebaseSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
  } as StoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  let storedScene: StoredScene | null = null;
  let previousStoredScene = await getSceneFromStore(roomId);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nextElements = previousStoredScene
      ? getSyncableElements(
          reconcileElements(
            elements,
            getSyncableElements(
              restoreElements(
                await decryptElements(previousStoredScene, roomKey),
                null,
              ),
            ) as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
            appState,
          ),
        )
      : elements;

    const nextScene = await createFirebaseSceneDocument(nextElements, roomKey);
    const saveResult = await saveSceneToStore(
      roomId,
      nextScene,
      previousStoredScene?.sceneVersion ?? null,
    );

    if (!saveResult.conflicted) {
      storedScene = saveResult.scene;
      break;
    }

    previousStoredScene = await getSceneFromStore(roomId);
  }

  if (!storedScene) {
    throw new Error("Could not persist scene due to concurrent updates.");
  }

  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  SceneVersionCache.set(socket, storedElements);

  return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const storedScene = await getSceneFromStore(roomId);
  if (!storedScene) {
    return null;
  }

  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    SceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  ensureApiBaseUrl(
    FILES_API_BASE_URL_GET,
    "Files GET API base URL (VITE_APP_BACKEND_V2_GET_URL)",
  );

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const objectPath = getStorageObjectPath(prefix, id);
        const response = await fetch(
          joinUrl(
            FILES_API_BASE_URL_GET,
            `files/${encodeURIComponent(objectPath)}`,
          ),
          {
            method: "GET",
            headers: {
              ...createPersistenceHeaders(),
            },
          },
        );
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
