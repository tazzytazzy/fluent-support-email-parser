/*
* This constant defines the mapping between a domain and the names of the
* environment variables that hold its credentials. This is the new source of truth.
*/
const domainCredentialConfig = {
    'example.com': {
        userVar: 'EXAMPLE_COM_USER',
        passVar: 'EXAMPLE_COM_PASS'
    },
    'anotherexample.com': {
        userVar: 'ANOTHEREXAMPLE_COM_USER',
        passVar: 'ANOTHEREXAMPLE_COM_PASS'
    }
};

/*
* This object holds the actual credential values at runtime, loaded from
* the environment variables defined in the config above.
* It is constructed dynamically and remains compatible with the handler.
*/
const domainCredentials = Object.entries(domainCredentialConfig).reduce((acc, [domain, config]) => {
    acc[domain] = {
        username: process.env[config.userVar],
        password: process.env[config.passVar]
    };
    return acc;
}, {});


// Export both for use in the handler and the test suite
exports.domainCredentialConfig = domainCredentialConfig;
exports.domainCredentials = domainCredentials;

/*
* Maps an inbound email address to its corresponding Fluent Support webhook URL.
*
* To add a new inbox, get the webhook URL from your Fluent Support settings
* and add a new entry to the channelMaps object below.
 */
exports.getChannel = (email, forwarder) => {
    const channelMaps = {
//        'your_own_masked_email@domain.com': 'WEBHOOK_URL',
        'support@example.com': 'https://example.com/wp-json/fluent-support/v2/mail-piping/1/push/3eacf384048826ff',
        'support@anotherexample.com': 'https://anotherexample.com/wp-json/fluent-support/v2/mail-piping/1/push/3362bfbfca95913a',
    }
    // This logic correctly finds the webhook for either the primary email or the forwarder.
    const webhookUrl = channelMaps[email] || channelMaps[forwarder];

    return webhookUrl || false;

}