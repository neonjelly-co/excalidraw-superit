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

const env = import.meta.env as ImportMetaEnv & {
  VITE_APP_BACKEND_V2_GET_URL: string;
  VITE_APP_BACKEND_V2_POST_URL: string;
};

const BACKEND_V2_GET_URL = env.VITE_APP_BACKEND_V2_GET_URL ?? "";
const BACKEND_V2_POST_URL = env.VITE_APP_BACKEND_V2_POST_URL ?? "";

const ensureApiBaseUrl = (baseUrl: string, label: string) => {
  if (!baseUrl) {
    throw new Error(
      `${label} is not configured. Set VITE_APP_BACKEND_V2_GET_URL and VITE_APP_BACKEND_V2_POST_URL.`,
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
    baseUrl: BACKEND_V2_POST_URL,
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
  ensureApiBaseUrl(BACKEND_V2_GET_URL, "Backend V2 GET URL");

  const response = await fetch(
    joinUrl(BACKEND_V2_GET_URL, `scenes/${encodeURIComponent(roomId)}`),
    {
      method: "GET",
    },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed loading scene from store (${response.status}).`);
  }

  return JSON.parse(await response.text()) as StoredScene;
};

const saveSceneToStore = async (
  roomId: string,
  scene: StoredScene,
  expectedSceneVersion: number | null,
): Promise<{ scene: StoredScene; conflicted: boolean }> => {
  ensureApiBaseUrl(BACKEND_V2_POST_URL, "Backend V2 POST URL");

  const body = new TextEncoder().encode(JSON.stringify(scene));

  const response = await fetch(
    joinUrl(BACKEND_V2_POST_URL, encodeURIComponent(roomId)),
    {
      method: "PUT",
      body,
    },
  );

  if (!response.ok) {
    throw new Error(`Failed saving scene to store (${response.status}).`);
  }

  return { scene, conflicted: false };
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

  ensureApiBaseUrl(BACKEND_V2_POST_URL, "Backend V2 POST URL");

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const objectPath = getStorageObjectPath(prefix, id);
        const response = await fetch(
          joinUrl(
            BACKEND_V2_POST_URL,
            `files/${encodeURIComponent(objectPath)}`,
          ),
          {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "cache-control": `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
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

  ensureApiBaseUrl(BACKEND_V2_GET_URL, "Backend V2 GET URL");

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const objectPath = getStorageObjectPath(prefix, id);
        const response = await fetch(
          joinUrl(
            BACKEND_V2_GET_URL,
            `files/${encodeURIComponent(objectPath)}`,
          ),
          {
            method: "GET",
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
