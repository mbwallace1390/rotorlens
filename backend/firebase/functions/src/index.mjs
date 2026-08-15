import {getApp, getApps, initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {HttpsError, onCall} from 'firebase-functions/v2/https';
import {
  CommunityBackendError,
  COMMUNITY_DEMO_PROJECT_ID,
  deleteCommunityAircraft,
  isExactCommunityEmulatorRuntime,
  rejectCommunitySubmission,
  readCommunityStats
} from './backend.mjs';

if (getApps().length === 0) {
  initializeApp({projectId: COMMUNITY_DEMO_PROJECT_ID});
}

const app = getApp();
const db = getFirestore(app);

const WRITE_OPTIONS = Object.freeze({
  region: 'us-central1',
  cors: false,
  enforceAppCheck: true,
  consumeAppCheckToken: true,
  minInstances: 0,
  maxInstances: 3,
  concurrency: 20,
  timeoutSeconds: 15,
  memory: '256MiB'
});

const READ_OPTIONS = Object.freeze({
  region: 'us-central1',
  cors: false,
  enforceAppCheck: true,
  consumeAppCheckToken: false,
  minInstances: 0,
  maxInstances: 2,
  concurrency: 40,
  timeoutSeconds: 10,
  memory: '256MiB'
});

function requireAppCheck(request, consumeToken) {
  if (!request.app) {
    throw new HttpsError(
      'unauthenticated',
      'Verified app evidence is required.',
      {code: 'APP_CHECK_REQUIRED'}
    );
  }
  if (consumeToken && request.app.alreadyConsumed === true) {
    throw new HttpsError(
      'permission-denied',
      'The app evidence was already used.',
      {code: 'APP_CHECK_REPLAYED'}
    );
  }
}

function requireEmulatorRuntime() {
  if (!isExactCommunityEmulatorRuntime(process.env, app.options.projectId)) {
    throw new HttpsError(
      'failed-precondition',
      'The community backend is not activated.',
      {code: 'BACKEND_NOT_ACTIVATED'}
    );
  }
}

function mapFailure(error) {
  if (error instanceof HttpsError) {
    throw error;
  }
  if (error instanceof CommunityBackendError) {
    throw new HttpsError(
      error.status,
      'The community request was refused.',
      error.details === null
        ? {code: error.code}
        : {code: error.code, ...error.details}
    );
  }
  throw new HttpsError(
    'internal',
    'The community request could not be processed.',
    {code: 'COMMUNITY_BACKEND_INTERNAL'}
  );
}

export const submitCommunityContribution = onCall(WRITE_OPTIONS, async request => {
  try {
    requireEmulatorRuntime();
    requireAppCheck(request, true);
    return rejectCommunitySubmission(request.data);
  } catch (error) {
    return mapFailure(error);
  }
});

export const deleteCommunityContributions = onCall(WRITE_OPTIONS, async request => {
  try {
    requireEmulatorRuntime();
    requireAppCheck(request, true);
    return await deleteCommunityAircraft(db, request.data);
  } catch (error) {
    return mapFailure(error);
  }
});

export const getCommunityStats = onCall(READ_OPTIONS, async request => {
  try {
    requireEmulatorRuntime();
    requireAppCheck(request, false);
    return await readCommunityStats(db, request.data);
  } catch (error) {
    return mapFailure(error);
  }
});
