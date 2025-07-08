'use strict';

// Use dotenv to load local environment variables from a .env file
require('dotenv').config();

// Use both sync and async fs for different purposes in the test file
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { Readable } = require('stream');

// Import testing libraries
const sinon = require('sinon');
const { expect } = require('chai');

// Import the handler and its dependencies
const handler = require('./handler');
const { domainCredentials, domainCredentialConfig } = require('./mappers');
const axios = require('axios');
const { S3Client } = require('@aws-sdk/client-s3');

/**
 * Generates dynamic mime content for testing by replacing placeholders.
 * @param {string} emailAddress - The email address to inject into the mime file.
 * @returns {Promise<Buffer>} A buffer containing the modified mime content.
 */
async function generateMimeContent(emailAddress) {
    const mimeTemplatePath = path.join(__dirname, 'test_assets', 'sample_in');
    const template = await fsp.readFile(mimeTemplatePath, 'utf-8');
    const modifiedContent = template.replace(/TEST_EMAIL_ADDRESS/g, emailAddress);
    return Buffer.from(modifiedContent);
}

/**
 * An integration test suite for the postprocess Lambda handler.
 * It is dynamically configured via the .env file.
 */
describe('Email Processing Handler', () => {
    let s3Stub;
    let axiosStub;

    // Before running tests, do a pre-flight check of the .env configuration
    before(() => {
        const envPath = path.join(__dirname, '.env');
        if (!fs.existsSync(envPath)) {
            throw new Error(`FATAL: .env file not found. Please copy .env-example to .env and fill it out before running tests.`);
        }

        // 1. Start with the static variables required for any test run.
        const staticVars = ['TEST_EMAIL_ADDRESS', 'TEST_EXPECTED_WEBHOOK_URL'];

        // 2. Dynamically get all credential variable names from the mapper config.
        const dynamicCredentialVars = Object.values(domainCredentialConfig)
            .flatMap(config => [config.userVar, config.passVar]);

        // 3. Combine them into the full list of required variables.
        const requiredVars = [...staticVars, ...dynamicCredentialVars];

        const missingVars = requiredVars.filter(v => !process.env[v]);
        if (missingVars.length > 0) {
            throw new Error(`FATAL: Missing required environment variables in .env file for testing: ${missingVars.join(', ')}`);
        }
    });

    // Before each test, set up the stubs
    beforeEach(() => {
        s3Stub = sinon.stub(S3Client.prototype, 'send');
        axiosStub = sinon.stub(axios, 'post');
    });

    // After each test, restore the original methods
    afterEach(() => {
        sinon.restore();
    });

    it('should parse a sample email and post the correct payload to the webhook', async () => {
        // --- 1. Setup the Test ---
        const mimeContent = await generateMimeContent(process.env.TEST_EMAIL_ADDRESS);
        const mockS3Event = {
            Records: [{
                s3: {
                    bucket: { name: 'fluentsupportinboundemail' },
                    object: { key: 'test-email-key' },
                },
            }, ],
        };

        s3Stub.resolves({ Body: Readable.from(mimeContent) });
        axiosStub.resolves({ status: 200, data: { message: 'Payload received' } });

        // --- 2. Execute the Handler ---
        console.log(`--- Calling handler.postprocess for email: ${process.env.TEST_EMAIL_ADDRESS} ---`);
        await handler.postprocess(mockS3Event);
        console.log('--- Handler execution finished ---');

        // --- 3. Assert the Results ---
        console.log('--- Verifying results ---');

        expect(axiosStub.calledOnce).to.be.true;
        const [url, payload, config] = axiosStub.getCall(0).args;

        // Assert against the expected webhook URL from .env
        const expectedUrl = process.env.TEST_EXPECTED_WEBHOOK_URL;
        expect(url).to.equal(expectedUrl);
        console.log(`✅ Correct webhook URL was called: ${url}`);

        // Dynamically find the correct credentials to assert against
        const domain = new URL(expectedUrl).hostname;
        const domainCreds = domainCredentials[domain];
        expect(domainCreds, `Credentials for domain '${domain}' not found in mappers.js`).to.exist;

        const expectedCredentials = Buffer.from(`${domainCreds.username}:${domainCreds.password}`).toString('base64');
        expect(config.headers.Authorization).to.equal(`Basic ${expectedCredentials}`);
        console.log(`✅ Authorization header is correct for domain: ${domain}`);

        const parsedPayload = JSON.parse(payload.payload);
        expect(parsedPayload.subject).to.equal('[Fluent Support] Some plugins were automatically updated');
        console.log(`✅ Parsed subject is correct: "${parsedPayload.subject}"`);

        console.log('\n✅ Test passed successfully!');
    });
});