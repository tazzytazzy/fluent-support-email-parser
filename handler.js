'use strict';

// AWS SDK v3 is modular. We import commands and clients as needed.
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const axios = require('axios');
const { simpleParser, MailParser } = require('mailparser');
const EmailReplyParser = require("email-reply-parser");
const TurndownService = require("turndown");

const { getChannel, domainCredentials } = require("./mappers");

// --- Initialization ---
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const turndownService = new TurndownService();
const mailParser = new MailParser();
const s3AttachmentBucketName = process.env.S3_ATTACHMENT_BUCKET || 'fluentsupportinboundemail';

// --- Conditional Logging Helper ---
// Checks the STAGE environment variable. Logs only appear if STAGE is 'dev'.
const isDev = process.env.STAGE === 'dev';
const logDev = (...args) => {
    if (isDev) {
        console.log(...args);
    }
};

/**
 * Extracts the primary 'to' address from the email data.
 * @param {object} toData - The 'to' object from the parsed email.
 * @returns {object} The first address object.
 */
function parseEmailTo(toData) {
    logDev('Parsing "to" address from:', toData);
    return toData?.value[0];
}

module.exports.postprocess = async (event) => {
    logDev('Received event:', JSON.stringify(event, null, 2));
    const record = event.Records[0];
    const sourceBucket = record.s3.bucket.name;
    const sourceKey = record.s3.object.key;

    try {
        // --- 1. Fetch and Parse Email from S3 ---
        const getObjectCmd = new GetObjectCommand({
            Bucket: sourceBucket,
            Key: sourceKey,
        });
        const s3Object = await s3Client.send(getObjectCmd);
        // SDK v3 streams the body; we need to convert it to a buffer for the parser.
        const email = await simpleParser(s3Object.Body);

        const to = parseEmailTo(email.to);
        if (!to?.address) {
            // IMPROVED: This is a non-critical warning, not a system error.
            console.log(`WARN: Could not determine a "to" address. Aborting.`, { sourceKey });
            return;
        }

        // --- 2. Determine Webhook URL ---
        const webhookUrl = getChannel(to.address, email.headers.get('x-forwarded-to'));
        if (!webhookUrl) {
            // IMPROVED: This is an expected outcome, not a system error.
            console.log(`INFO: No Webhook URL found for email. Mime: ${sourceKey}; To: ${to.address}`);
            return; // No configuration found, processing stops.
        }

        // --- 3. Process Email Body ---
        let visibleText;
        if (email.html) {
            // Strip the <head> tag to avoid CSS styles being converted to markdown
            const cleanHtml = email.html.replace(/<head>.*<\/head>/s, '');
            email.text = turndownService.turndown(cleanHtml);
        }
        visibleText = new EmailReplyParser().read(email.text).getVisibleText();

        // --- 4. Handle Forwarded Messages ---
        let forwarded = null;
        const fwdMatches = visibleText.match(/(?<=From:\s+)(.*?)(?=>)/);
        if (fwdMatches) {
            const forwardedParts = fwdMatches[0].split('<');
            forwarded = {
                name: forwardedParts[0].trim(),
                address: forwardedParts[1].trim()
            };
            // Clean up forwarding headers from the visible text
            visibleText = visibleText.replace(/From:.+?(?=To:)[^>]*>/sg, '');
            visibleText = visibleText.replace(/---------- Forwarded message ---------/g, '');
        }

        // --- 5. Process Attachments in Parallel ---
        const attachmentUploadPromises = email.attachments.map(async (attachment) => {
            const key = `${Date.now()}_${attachment.filename.replace(/\s/g, '_')}`;
            const putCmd = new PutObjectCommand({
                Bucket: s3AttachmentBucketName,
                Key: key,
                Body: attachment.content,
                ContentType: attachment.contentType,
            });
            await s3Client.send(putCmd);

            // Create a presigned URL for the attachment
            const getCmd = new GetObjectCommand({ Bucket: s3AttachmentBucketName, Key: key });
            const url = await getSignedUrl(s3Client, getCmd, { expiresIn: 3600 * 24 * 7 }); // 7-day expiry

            return {
                url,
                cid: attachment.cid,
                filename: attachment.filename,
                contentType: attachment.contentType,
                contentDisposition: attachment.contentDisposition,
            };
        });

        const attachments = await Promise.all(attachmentUploadPromises);

        // --- 6. Prepare and Send Payload ---
        const formattedData = {
            date: email.date,
            subject: email.subject,
            body_text: mailParser.textToHtml(visibleText.trim()),
            messageId: email.messageId,
            from: email.from,
            to: email.to,
            forwarded,
            attachments,
            isMarkDown: !!email.html, // Set true if original email had HTML
        };

        const postedData = JSON.stringify(formattedData);
        const headers = {}; // A great place too additional headers, for example, to get around some firewall rules.
        // Add the custom auth header ONLY if the environment variable is set
        if (process.env.CUSTOM_AUTH_HEADER) {
            headers[process.env.CUSTOM_AUTH_HEADER] = process.env.CUSTOM_AUTH_HEADER_VALUE;
        }

        try {
            const domain = new URL(webhookUrl).hostname;
            const auth = domainCredentials[domain];
            if (auth?.username && auth?.password) {
                const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
                headers['Authorization'] = `Basic ${credentials}`;
                logDev(`Applying credentials for domain: ${domain}`);
            } else {
                logDev(`No credentials found for domain: ${domain}.`);
            }
        } catch (urlError) {
            // This is a potential configuration error, so console.error is appropriate.
            console.error('Could not parse domain from webhookUrl:', webhookUrl, urlError);
        }

        logDev(`Posting to webhook: ${webhookUrl}`);
        await axios.post(webhookUrl, { payload: postedData }, { headers });
        logDev(`Successfully posted to ${webhookUrl}`);

    } catch (error) {
        // This is a true error, so console.error is appropriate.
        console.error('An unhandled error occurred in the postprocess handler:', {
            errorMessage: error.message,
            errorStack: error.stack,
            s3ObjectKey: sourceKey,
        });
        // Re-throw the error to allow AWS Lambda to handle retries if configured
        throw error;
    }
};

// Explicitly export the function for testing purposes
module.exports.postprocess = module.exports.postprocess;