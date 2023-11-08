require('source-map-support').install()
const {App} = require('@slack/bolt');
const {OpenAI} = require('openai');
require('dotenv').config();

// Load environment variables
const slackToken = process.env.SLACK_BOT_TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;

const TIME_BUFFER = 1000

// Initialize Slack Bolt App
const app = new App({
    token: slackToken,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
});

// Initialize OpenAI API
const openai = new OpenAI({
    apiKey: openaiApiKey,
});

async function fetchSlackHistory(conversationId, threadTs) {
    const history = await app.client.conversations.history({
        token: process.env.SLACK_BOT_TOKEN,
        channel: conversationId,
        ...(threadTs ? {latest: threadTs, inclusive: true, limit: 1} : {}),
    });

    const messages = history.messages;

    // If it's a thread, fetch the entire thread
    if (threadTs && messages[0]?.thread_ts) {
        const threadHistory = await app.client.conversations.replies({
            token: process.env.SLACK_BOT_TOKEN,
            channel: conversationId,
            ts: threadTs,
        });
        return threadHistory.messages.map(msg => ({role: "user", content: msg.text}));
    }

    return messages.map(msg => ({role: "user", content: msg.text}));
}


app.message(async ({message, context, say}) => {
    try {
        if (message.bot_id) return; // Ignore messages from bots
        if (message.subtype) return; // Ignore messages with subtypes (e.g. message_changed)

        const botUserId = context.botUserId;
        const isMentioned = message.text.includes(`<@${botUserId}>`);
        const isDirectMessage = message.channel_type === 'im';
        const isInThread = message.thread_ts != null;
        const shouldRespond = isDirectMessage || (isMentioned);

        if (shouldRespond) {
            const threadId = message.thread_ts || message.ts;

            // Fetch conversation history from Slack
            const messages = await fetchSlackHistory(message.channel, threadId);

            // Generate response from OpenAI
            const stream = await openai.chat.completions.create({
                model: 'gpt-4',
                messages: messages,
                stream: true
            });


            let cumulativeContent = '';
            let slackMessageTs = '';
            let lastUpdateTime = 0;

            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || '';
                cumulativeContent += content;
                const currentTime = Date.now();

                if (currentTime - lastUpdateTime >= TIME_BUFFER) { // 2 seconds have passed
                    if (cumulativeContent.trim()) { // Check if there's content to send
                        if (slackMessageTs) {
                            // Edit the message with cumulative content
                            await app.client.chat.update({
                                token: context.botToken,
                                channel: message.channel,
                                ts: slackMessageTs,
                                text: cumulativeContent
                            });
                        } else {
                            // Send initial message
                            const postedMessage = await app.client.chat.postMessage({
                                token: context.botToken,
                                channel: message.channel,
                                text: cumulativeContent,
                                thread_ts: threadId
                            });
                            slackMessageTs = postedMessage.ts;
                        }
                        lastUpdateTime = currentTime;
                    }
                }
            }

            // Process any remaining content after the stream ends
            if (Date.now() - lastUpdateTime > 0 && cumulativeContent.trim()) {
                await app.client.chat.update({
                    token: context.botToken,
                    channel: message.channel,
                    ts: slackMessageTs,
                    text: cumulativeContent
                });
            }
        }
    } catch (error) {
        console.error("An error occurred: ", error);
    }
    
});


// Start the app
(async () => {
    await app.start();
    console.log('Slack bot is running');
})();