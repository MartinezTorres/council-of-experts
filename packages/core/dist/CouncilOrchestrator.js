/**
 * Council Orchestrator - Main orchestration class
 */
import { AIClient } from './AIClient.js';
import { ToolSystem } from './ToolSystem.js';
import { removeThinkingTags } from './utils.js';
import { DEFAULT_MAX_TOKENS, AI_TIMEOUT_MS } from './constants.js';
export class CouncilOrchestrator {
    documentProvider;
    settingsProvider;
    loggerProvider;
    broadcaster;
    aiClient; // Public for utility access
    toolSystem;
    responseCallback;
    constructor(config) {
        this.documentProvider = config.documentProvider;
        this.settingsProvider = config.settingsProvider;
        this.loggerProvider = config.loggerProvider;
        this.broadcaster = config.broadcaster;
        this.aiClient = new AIClient(this.settingsProvider, this.loggerProvider);
        this.toolSystem = new ToolSystem(this.documentProvider, this.settingsProvider, this.aiClient, this.broadcaster);
    }
    /**
     * Set callback for expert responses
     */
    onResponse(callback) {
        this.responseCallback = callback;
    }
    /**
     * Register a custom tool
     */
    registerTool(tool, executor) {
        this.toolSystem.registerTool(tool, executor);
    }
    /**
     * Orchestrate experts responding to a message
     */
    async orchestrate(documentId, userMessage, triggerUserId, experts, context, options = {}) {
        if (experts.length === 0)
            return;
        const { isIndirectInvocation = false } = options;
        if (this.loggerProvider) {
            await this.loggerProvider.logOperation('council_orchestrate', triggerUserId, {
                documentId,
                expertCount: experts.length
            });
        }
        // Execute all experts in parallel
        const promises = experts.map(expert => this.executeExpert(documentId, userMessage, triggerUserId, expert, context, isIndirectInvocation));
        await Promise.all(promises);
    }
    async executeExpert(documentId, userMessage, triggerUserId, expert, context, isIndirectInvocation) {
        try {
            // Emit started event
            if (this.broadcaster) {
                this.broadcaster.emit(`document:${documentId}`, 'expert-started', {
                    expertUserId: expert.userId,
                    startedAt: new Date().toISOString()
                });
            }
            // Build prompts
            const systemPrompt = await this.buildSystemPrompt(expert, context, documentId, isIndirectInvocation);
            const userPrompt = this.buildUserPrompt(userMessage, context.chatHistory || '', expert.name, isIndirectInvocation);
            // Get tools
            const tools = this.toolSystem.getOpenAITools();
            // Call AI with timeout protection
            const response = await Promise.race([
                this.aiClient.chat(userPrompt, expert.model, expert.temperature, DEFAULT_MAX_TOKENS, systemPrompt, tools),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${AI_TIMEOUT_MS}ms`)), AI_TIMEOUT_MS))
            ]);
            const cleanedContent = response.content.trim();
            const cleanedWithoutThinking = removeThinkingTags(cleanedContent);
            // Skip if empty or "SKIP" and no tool calls
            if ((!cleanedWithoutThinking || cleanedWithoutThinking.toUpperCase() === 'SKIP') && !response.toolCalls) {
                return;
            }
            // Execute tools if present
            let finalMessage = cleanedContent;
            if (response.toolCalls && response.toolCalls.length > 0) {
                const toolResults = await Promise.all(response.toolCalls.map(tc => this.toolSystem.executeTool(tc.name, tc.arguments, {
                    documentId,
                    expertUserId: expert.userId,
                    triggerUserId
                })));
                // Check if tools need processing
                const needsProcessing = response.toolCalls.some(tc => {
                    const tool = this.toolSystem.getTool(tc.name);
                    return tool?.needsProcessing;
                });
                if (needsProcessing && toolResults.some(tr => tr.success)) {
                    // Call AI again with tool results
                    let toolContext = 'You used the following tools:\n\n';
                    toolResults.forEach((tr, i) => {
                        const tc = response.toolCalls[i];
                        toolContext += `Tool: ${tr.tool}\n`;
                        toolContext += `Arguments: ${JSON.stringify(tc.arguments)}\n`;
                        toolContext += `Result:\n${tr.result}\n\n`;
                    });
                    const followUpPrompt = `${toolContext}Now provide your final response incorporating the tool results:`;
                    const followUpResponse = await this.aiClient.chat(followUpPrompt, expert.model, expert.temperature, DEFAULT_MAX_TOKENS, systemPrompt
                    // No tools on second call - prevent recursion
                    );
                    finalMessage = followUpResponse.content.trim();
                }
                else if (!cleanedContent) {
                    // No message from expert, summarize tool execution
                    const successfulTools = toolResults.filter(tr => tr.success);
                    if (successfulTools.length > 0) {
                        finalMessage = `Used tool${successfulTools.length > 1 ? 's' : ''}: ${successfulTools.map(tr => tr.tool).join(', ')}`;
                    }
                }
            }
            // Send response
            if (finalMessage && removeThinkingTags(finalMessage).toUpperCase() !== 'SKIP') {
                const expertResponse = {
                    expertUserId: expert.userId,
                    message: finalMessage,
                    timestamp: new Date().toISOString(),
                    diagnosticId: response.diagnosticId
                };
                if (this.responseCallback) {
                    await this.responseCallback(expertResponse, documentId);
                }
                // Emit completed event
                if (this.broadcaster) {
                    this.broadcaster.emit(`document:${documentId}`, 'expert-completed', {
                        expertUserId: expert.userId,
                        message: finalMessage,
                        completedAt: new Date().toISOString()
                    });
                }
            }
        }
        catch (error) {
            if (this.loggerProvider) {
                await this.loggerProvider.logError(`expert_${expert.userId}`, error);
            }
            const errorMessage = `Error: ${error.message}`;
            // Emit error event
            if (this.broadcaster) {
                this.broadcaster.emit(`document:${documentId}`, 'expert-error', {
                    expertUserId: expert.userId,
                    error: errorMessage
                });
            }
            // Send error as response
            if (this.responseCallback) {
                await this.responseCallback({
                    expertUserId: expert.userId,
                    message: `**Error**: ${errorMessage}`,
                    timestamp: new Date().toISOString()
                }, documentId);
            }
        }
    }
    async buildSystemPrompt(expert, context, documentId, isIndirectInvocation) {
        let prompt = `You are ${expert.name} ${expert.icon}\n\n`;
        prompt += expert.systemPrompt + '\n\n';
        const chatSystemPrompt = await this.settingsProvider.getSetting('chat_system_prompt');
        if (chatSystemPrompt) {
            prompt += chatSystemPrompt + '\n\n';
        }
        if (context.documentContent) {
            prompt += `<document>\n${context.documentContent}\n</document>\n\n`;
        }
        // Add attachments list
        try {
            const doc = await this.documentProvider.getDocument(documentId);
            if (doc.attachments && doc.attachments.length > 0) {
                prompt += '<attachments>\n';
                for (const att of doc.attachments) {
                    const fileNames = att.files.map(f => f.filename).join(', ');
                    prompt += `- ${att.id} (${att.type}): ${att.description || 'No description'} - Files: ${fileNames}\n`;
                }
                prompt += '</attachments>\n\n';
            }
        }
        catch {
            // Ignore errors
        }
        if (isIndirectInvocation) {
            prompt += `INDIRECT INVOCATION: You were not explicitly mentioned. Only respond if relevant to your expertise. Otherwise respond with "SKIP".`;
        }
        else {
            prompt += `DIRECT INVOCATION: You were explicitly mentioned. Use available tools and provide a helpful response.`;
        }
        return prompt;
    }
    buildUserPrompt(userMessage, chatHistory, expertName, isIndirectInvocation) {
        const currentTime = new Date().toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        let prompt = '';
        if (chatHistory) {
            prompt += `<conversation_history>\n${chatHistory}</conversation_history>\n\n`;
        }
        prompt += `<new_message>\n[${currentTime}] Human${isIndirectInvocation ? ' (indirect)' : ''}: ${userMessage}\n</new_message>\n\n`;
        prompt += `<expert_context>\n`;
        prompt += `You are: "${expertName}"\n`;
        prompt += `Current time: ${currentTime}\n`;
        prompt += `Invocation type: ${isIndirectInvocation ? 'INDIRECT' : 'DIRECT'}\n`;
        prompt += `</expert_context>\n\n`;
        prompt += `Provide your response below:\n`;
        return prompt;
    }
    /**
     * Get AI diagnostic by ID
     */
    getDiagnostic(id) {
        return this.aiClient.getDiagnostic(id);
    }
    /**
     * Get diagnostics for a model
     */
    getModelDiagnostics(modelName) {
        return this.aiClient.getModelDiagnostics(modelName);
    }
    /**
     * Summarize text using configured summarization model
     */
    async summarize(text) {
        return this.aiClient.summarize(text);
    }
}
//# sourceMappingURL=CouncilOrchestrator.js.map