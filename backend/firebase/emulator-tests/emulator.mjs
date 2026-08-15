import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {after, before, beforeEach, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  assertFails,
  initializeTestEnvironment
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc
} from 'firebase/firestore';
import {
  CommunityBackendError,
  deleteCommunityAircraft,
  readCommunityStats,
  rejectCommunitySubmission
} from '../functions/src/backend.mjs';
import {
  TEST_CONTRIBUTION_ID,
  TEST_DELETION_CAPABILITY,
  TEST_OTHER_DELETION_CAPABILITY,
  TEST_SHARING_ID,
  buildDraftContribution,
  deletion,
  statsRequest,
  submission
} from './fixture.mjs';

const firebaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectId = 'demo-rotorlens';
const functionsRequire = createRequire(
  new URL('../functions/package.json', import.meta.url)
);
const {deleteApp, getApps, initializeApp} = functionsRequire('firebase-admin/app');
const {getFirestore} = functionsRequire('firebase-admin/firestore');
let adminApp;
let db;
let testEnvironment;

function backendDigest(domain, value) {
  return createHash('sha256')
    .update(`rotorlens-community-backend-v1\0${domain}\0`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function mutable(value) {
  return structuredClone(value);
}

async function expectBackendError(action, code) {
  await assert.rejects(action, error => {
    assert.equal(error instanceof CommunityBackendError, true);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /private fixture name|01234-56789/);
    return true;
  });
}

async function seedSyntheticValidatedAircraft() {
  const aircraftDigest = backendDigest('aircraft', TEST_SHARING_ID);
  const contributionDigest = backendDigest('contribution', TEST_CONTRIBUTION_ID);
  const capabilityDigest = backendDigest(
    'deletion-capability',
    TEST_DELETION_CAPABILITY
  );
  const aircraftRef = db.collection('communityAircraft').doc(aircraftDigest);
  const contributionRef = aircraftRef.collection('contributions').doc(contributionDigest);
  const claimRef = db.collection('communityContributionClaims').doc(contributionDigest);
  const statsRef = db.collection('communityInternal').doc('stats');
  const batch = db.batch();
  batch.set(aircraftRef, {
    schemaVersion: 1,
    kind: 'rotorlens-community-aircraft-v1',
    deletionCapabilityDigest: capabilityDigest,
    contributionCount: 1,
    validatedContributionCount: 1,
    modelEligibleContributionCount: 0
  });
  batch.set(contributionRef, {
    schemaVersion: 1,
    kind: 'rotorlens-community-test-fixture-v1',
    status: 'synthetic-validated-test-only',
    productionEligible: false,
    modelEligible: false
  });
  batch.set(claimRef, {
    schemaVersion: 1,
    kind: 'rotorlens-community-claim-test-fixture-v1',
    aircraftDigest
  });
  batch.set(statsRef, {
    schemaVersion: 1,
    kind: 'rotorlens-community-internal-stats-v1',
    validatedAircraftCount: 1,
    validatedFlightCount: 1,
    modelEligibleFlightCount: 0
  });
  await batch.commit();
}

before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator must be active');
  const rules = await readFile(path.join(firebaseRoot, 'firestore.rules'), 'utf8');
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {rules}
  });
  adminApp = initializeApp({projectId}, `rotorlens-backend-${process.pid}`);
  db = getFirestore(adminApp);
});

beforeEach(async () => {
  await testEnvironment.clearFirestore();
});

after(async () => {
  await testEnvironment?.cleanup();
  await Promise.all(getApps()
    .filter(app => app.name === adminApp?.name)
    .map(app => deleteApp(app)));
});

test('direct Firestore clients cannot read or write any collection', async () => {
  const anonymous = testEnvironment.unauthenticatedContext().firestore();
  const authenticated = testEnvironment.authenticatedContext('test-user').firestore();
  const target = doc(anonymous, 'communityInternal', 'stats');
  await assertFails(setDoc(target, {validatedFlightCount: 999}));
  await assertFails(getDoc(target));
  await assertFails(getDocs(collection(anonymous, 'communityInternal')));
  await assertFails(getDoc(doc(authenticated, 'communityInternal', 'stats')));
  await assertFails(getDocs(collection(authenticated, 'communityInternal')));
  await assertFails(setDoc(
    doc(authenticated, 'communityInternal', 'stats'),
    {validatedFlightCount: 999}
  ));
  await assertFails(updateDoc(
    doc(authenticated, 'communityInternal', 'stats'),
    {validatedFlightCount: 999}
  ));
  await assertFails(deleteDoc(doc(authenticated, 'communityInternal', 'stats')));
});

test('a draft-valid submission is refused with stable codes and zero writes', async () => {
  let refusal;
  try {
    rejectCommunitySubmission(submission());
    assert.fail('submission unexpectedly returned');
  } catch (error) {
    refusal = error;
  }
  assert.equal(refusal instanceof CommunityBackendError, true);
  assert.equal(refusal.code, 'PRODUCTION_INGESTION_CLOSED');
  assert.ok(refusal.details.auditCodes.includes('CONSENT_VERSION_NOT_ADOPTED'));
  assert.ok(refusal.details.auditCodes.includes('LICENCE_VERSION_NOT_ADOPTED'));
  assert.equal((await db.listCollections()).length, 0);
  assert.deepEqual(await readCommunityStats(db, statsRequest()), {
    schemaVersion: 1,
    kind: 'rotorlens-community-public-stats-v1',
    code: 'PUBLIC_STATS_WITHHELD',
    contributingHelicoptersLowerBound: null,
    validatedFlightsLowerBound: null,
    modelEligibleFlightsLowerBound: null,
    learningStatus: 'closed-no-production-corpus'
  });
});

test('malformed, extra, accessor and production-looking input all fail closed', () => {
  assert.throws(
    () => rejectCommunitySubmission(submission(undefined, {extra: true})),
    error => error.code === 'SUBMISSION_REQUEST_INVALID'
  );

  const malformed = mutable(buildDraftContribution());
  malformed.shareableRecord.craftName = 'must never enter storage';
  assert.throws(
    () => rejectCommunitySubmission(submission(malformed)),
    error => error.code === 'CONTRIBUTION_REJECTED'
  );

  let getterCalls = 0;
  const hostile = submission();
  Object.defineProperty(hostile, 'contribution', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return buildDraftContribution();
    }
  });
  assert.throws(
    () => rejectCommunitySubmission(hostile),
    error => error.code === 'REQUEST_JSON_INVALID'
  );
  assert.equal(getterCalls, 0);

  const productionLooking = mutable(buildDraftContribution());
  productionLooking.consentVersion = 'community-production-v1';
  productionLooking.licenceVersion = 'community-production-v1';
  assert.throws(
    () => rejectCommunitySubmission(submission(productionLooking)),
    error => error.code === 'LEGAL_RECEIPT_INVALID'
  );
});

test('public stats expose only validated k-anonymous lower-bound buckets', async () => {
  const statsRef = db.collection('communityInternal').doc('stats');
  await statsRef.set({
    schemaVersion: 1,
    kind: 'rotorlens-community-internal-stats-v1',
    validatedAircraftCount: 1,
    validatedFlightCount: 4,
    modelEligibleFlightCount: 0
  });
  assert.deepEqual(await readCommunityStats(db, statsRequest()), {
    schemaVersion: 1,
    kind: 'rotorlens-community-public-stats-v1',
    code: 'PUBLIC_STATS_WITHHELD',
    contributingHelicoptersLowerBound: null,
    validatedFlightsLowerBound: null,
    modelEligibleFlightsLowerBound: null,
    learningStatus: 'closed-no-production-corpus'
  });
  await statsRef.set({
    schemaVersion: 1,
    kind: 'rotorlens-community-internal-stats-v1',
    validatedAircraftCount: 5,
    validatedFlightCount: 24,
    modelEligibleFlightCount: 10
  });
  const bucketed = await readCommunityStats(db, statsRequest());
  assert.equal(bucketed.code, 'PUBLIC_STATS_AVAILABLE');
  assert.equal(bucketed.contributingHelicoptersLowerBound, 5);
  assert.equal(bucketed.validatedFlightsLowerBound, 10);
  assert.equal(bucketed.modelEligibleFlightsLowerBound, 10);
  assert.doesNotMatch(JSON.stringify(bucketed), /\b24\b/);
});

test('deletion requires the separate capability and leaves a replay tombstone', async () => {
  await seedSyntheticValidatedAircraft();
  let unauthorizedReads = 0;
  const observedDb = {
    collection: (...args) => db.collection(...args),
    runTransaction: callback => db.runTransaction(transaction => callback({
      get(reference) {
        unauthorizedReads += 1;
        return transaction.get(reference);
      },
      delete(reference) {
        return transaction.delete(reference);
      },
      set(reference, value) {
        return transaction.set(reference, value);
      }
    }))
  };
  await expectBackendError(
    () => deleteCommunityAircraft(observedDb, deletion({
      deletionCapability: TEST_OTHER_DELETION_CAPABILITY
    })),
    'DELETION_NOT_AUTHORIZED'
  );
  assert.equal(unauthorizedReads, 2);
  assert.equal((await db.collectionGroup('contributions').get()).size, 1);

  assert.deepEqual(await deleteCommunityAircraft(db, deletion()), {
    schemaVersion: 1,
    status: 'emulator-only',
    code: 'DELETED',
    deletedFlights: 1
  });
  assert.equal((await db.collectionGroup('contributions').get()).size, 0);
  assert.equal((await db.collection('communityAircraft').get()).size, 0);
  assert.equal((await db.collection('communityContributionClaims').get()).size, 0);
  const tombstones = await db.collection('communityDeletionTombstones').get();
  assert.equal(tombstones.size, 1);
  assert.doesNotMatch(JSON.stringify(tombstones.docs[0].data()), new RegExp(
    TEST_DELETION_CAPABILITY,
    'g'
  ));
  assert.deepEqual(await deleteCommunityAircraft(db, deletion()), {
    schemaVersion: 1,
    status: 'emulator-only',
    code: 'ALREADY_DELETED',
    deletedFlights: 0
  });
  assert.equal(
    (await readCommunityStats(db, statsRequest())).validatedFlightsLowerBound,
    null
  );
});

test('unknown stored-state schemas fail closed instead of being reinterpreted', async () => {
  const statsRef = db.collection('communityInternal').doc('stats');
  await statsRef.set({
    schemaVersion: 2,
    kind: 'rotorlens-community-internal-stats-v2',
    validatedAircraftCount: 5,
    validatedFlightCount: 10,
    modelEligibleFlightCount: 5
  });
  await expectBackendError(
    () => readCommunityStats(db, statsRequest()),
    'BACKEND_STATE_INVALID'
  );

  await testEnvironment.clearFirestore();
  await seedSyntheticValidatedAircraft();
  const aircraftDigest = backendDigest('aircraft', TEST_SHARING_ID);
  await db.collection('communityAircraft').doc(aircraftDigest).update({
    kind: 'rotorlens-community-aircraft-v2'
  });
  await expectBackendError(
    () => deleteCommunityAircraft(db, deletion()),
    'BACKEND_STATE_INVALID'
  );
});

test('impossible deletion state aborts without changing stored records', async () => {
  await seedSyntheticValidatedAircraft();
  const aircraftDigest = backendDigest('aircraft', TEST_SHARING_ID);
  const capabilityDigest = backendDigest(
    'deletion-capability',
    TEST_DELETION_CAPABILITY
  );
  await db.collection('communityDeletionTombstones').doc(aircraftDigest).set({
    schemaVersion: 1,
    kind: 'rotorlens-community-deletion-tombstone-v1',
    status: 'deleted',
    deletionCapabilityDigest: capabilityDigest
  });
  await expectBackendError(
    () => deleteCommunityAircraft(db, deletion()),
    'BACKEND_STATE_INVALID'
  );
  assert.equal((await db.collection('communityAircraft').get()).size, 1);
  assert.equal((await db.collectionGroup('contributions').get()).size, 1);

  await testEnvironment.clearFirestore();
  await seedSyntheticValidatedAircraft();
  const secondContributionId = backendDigest('contribution', 'second-synthetic-flight');
  const aircraftRef = db.collection('communityAircraft').doc(aircraftDigest);
  const batch = db.batch();
  batch.set(aircraftRef.collection('contributions').doc(secondContributionId), {
    schemaVersion: 1,
    kind: 'rotorlens-community-test-fixture-v1',
    status: 'synthetic-validated-test-only',
    productionEligible: false,
    modelEligible: false
  });
  batch.set(db.collection('communityContributionClaims').doc(secondContributionId), {
    schemaVersion: 1,
    kind: 'rotorlens-community-claim-test-fixture-v1',
    aircraftDigest
  });
  batch.update(aircraftRef, {
    contributionCount: 2,
    validatedContributionCount: 2
  });
  batch.set(db.collection('communityInternal').doc('stats'), {
    schemaVersion: 1,
    kind: 'rotorlens-community-internal-stats-v1',
    validatedAircraftCount: 5,
    validatedFlightCount: 5,
    modelEligibleFlightCount: 0
  });
  await batch.commit();
  await expectBackendError(
    () => deleteCommunityAircraft(db, deletion()),
    'BACKEND_STATE_INVALID'
  );
  assert.equal((await db.collection('communityAircraft').get()).size, 1);
  assert.equal((await db.collectionGroup('contributions').get()).size, 2);
  assert.equal(
    (await db.collection('communityInternal').doc('stats').get())
      .data().validatedFlightCount,
    5
  );
});

test('the callable emulator refuses a request with no App Check evidence', async () => {
  const response = await fetch(
    'http://127.0.0.1:5001/demo-rotorlens/us-central1/getCommunityStats',
    {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({data: statsRequest()})
    }
  );
  assert.equal(response.ok, false);
  assert.ok([401, 403].includes(response.status), `unexpected status ${response.status}`);
  const body = await response.text();
  assert.doesNotMatch(body, /private fixture name|01234-56789/);
});
