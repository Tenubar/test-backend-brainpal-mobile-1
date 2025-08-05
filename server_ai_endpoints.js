// AI Endpoints and OpenRouter Integration
// This file contains the missing AI endpoints that should be added to server.js

// Import mongoose for ApiReminder model
const mongoose = require('mongoose');

// OpenRouter API helper functions
async function callOpenRouterAPI(model, messages, userApiKey = null) {
  try {
    const apiKey = userApiKey || process.env.OPENROUTER_API_KEY;
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://brainpal.ai',
        'X-Title': 'BrainPal'
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      content: data.choices[0].message.content,
      tokensUsed: data.usage?.total_tokens || 0,
      model: data.model || model
    };
  } catch (error) {
    console.error('OpenRouter API call failed:', error);
    throw error;
  }
}

function getOpenRouterCost(tokensUsed, model) {
  // OpenRouter pricing per 1M tokens (approximate)
  const pricing = {
    'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
    'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },
    'google/gemini-2.5-flash': { input: 0.075, output: 0.30 }
  };
  
  const modelPricing = pricing[model] || pricing['openai/gpt-4o-mini'];
  
  // Estimate cost (assuming 50/50 split between input/output tokens)
  const inputTokens = Math.floor(tokensUsed * 0.5);
  const outputTokens = Math.ceil(tokensUsed * 0.5);
  
  const cost = (inputTokens * modelPricing.input / 1000000) + (outputTokens * modelPricing.output / 1000000);
  
  return parseFloat(cost.toFixed(6));
}

// Brain State Analysis Endpoint
app.post("/api/ai/analyze-brain-state", authenticateToken, async (req, res) => {
  try {
    const { brainDump, selectedModel = 'free' } = req.body;
    
    if (!brainDump || brainDump.trim().length === 0) {
      return res.status(400).json({ error: "Brain dump content is required" });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Determine model and API key based on selection
    let model, userApiKey = null;
    
    switch (selectedModel) {
      case 'free':
        model = 'openai/gpt-4o-mini';
        break;
      case 'premium_openai':
        model = 'openai/gpt-4o-mini';
        userApiKey = user.keys?.openai_api_key;
        if (!userApiKey) {
          return res.status(400).json({ error: "OpenAI API key not found" });
        }
        break;
      case 'premium_anthropic':
        model = 'anthropic/claude-3-haiku';
        userApiKey = user.keys?.anthropic_api_key;
        if (!userApiKey) {
          return res.status(400).json({ error: "Anthropic API key not found" });
        }
        break;
      case 'openai4om':
        model = 'openai/gpt-4o-mini';
        break;
      case 'claude3h':
        model = 'anthropic/claude-3-haiku';
        break;
      case 'gemini25':
        model = 'google/gemini-2.5-flash';
        break;
      default:
        model = 'openai/gpt-4o-mini';
    }

    // Get model-specific prompts from database
    const identityPrompt = await BrainPalPrompt.findOne({ 
      name: `brainpal_identity_${selectedModel}`,
      isActive: true 
    });
    
    const taskPrompt = await BrainPalPrompt.findOne({ 
      name: `brainpal_task_${selectedModel}`,
      isActive: true 
    });

    // Fallback to default prompts if model-specific ones don't exist
    const defaultIdentity = await BrainPalPrompt.findOne({ 
      name: 'brainpal_identity',
      isActive: true 
    });
    
    const defaultTask = await BrainPalPrompt.findOne({ 
      name: 'brainpal_task',
      isActive: true 
    });

    const systemPrompt = (identityPrompt || defaultIdentity)?.content || 
      "You are BrainPal, an exceptionally empathetic AI companion designed to help users understand and improve their mental wellness.";
    
    const analysisPrompt = (taskPrompt || defaultTask)?.content || 
      "Analyze the user's brain dump and provide emotional state assessment.";

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${analysisPrompt}\n\nBrain Dump: ${brainDump}` }
    ];

    // Call OpenRouter API
    const aiResponse = await callOpenRouterAPI(model, messages, userApiKey);
    
    // Track token usage
    await trackTokenUsage(req.user.userId, aiResponse.model, aiResponse.tokensUsed);
    
    // Calculate cost and log API request
    const cost = getOpenRouterCost(aiResponse.tokensUsed, aiResponse.model);
    
    await trackApiRequest(
      req.user.userId,
      user.email,
      'brain_analysis',
      'openrouter',
      aiResponse.tokensUsed,
      cost,
      'Brain state analysis',
      { model: aiResponse.model, selectedModel }
    );

    // Parse AI response for emotional metrics
    let emotionalState = 5, energyLevel = 5, brainClarity = 5;
    
    try {
      // Extract numerical scores from AI response
      const stateMatch = aiResponse.content.match(/emotional.*?(\d+)/i);
      const energyMatch = aiResponse.content.match(/energy.*?(\d+)/i);
      const clarityMatch = aiResponse.content.match(/clarity.*?(\d+)/i);
      
      if (stateMatch) emotionalState = parseInt(stateMatch[1]);
      if (energyMatch) energyLevel = parseInt(energyMatch[1]);
      if (clarityMatch) brainClarity = parseInt(clarityMatch[1]);
    } catch (parseError) {
      console.log('Could not parse emotional metrics from AI response, using defaults');
    }

    // Save brain state analysis
    const analysis = {
      brain_dump: brainDump,
      ai_analysis: aiResponse.content,
      emotional_state: Math.max(1, Math.min(10, emotionalState)),
      energy_level: Math.max(1, Math.min(10, energyLevel)),
      brain_clarity: Math.max(1, Math.min(10, brainClarity)),
      model_used: aiResponse.model,
      tokens_used: aiResponse.tokensUsed,
      created_at: new Date()
    };

    user.brainStateAnalysis.push(analysis);
    await user.save();

    // Update emotional status
    await updateEmotionalStatus(req.user.userId);

    res.json({
      analysis: aiResponse.content,
      emotional_state: analysis.emotional_state,
      energy_level: analysis.energy_level,
      brain_clarity: analysis.brain_clarity,
      model_used: aiResponse.model,
      tokens_used: aiResponse.tokensUsed
    });

  } catch (error) {
    console.error('Brain state analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze brain state: ' + error.message });
  }
});

// Task Generation Endpoint
app.post("/api/ai/generate-tasks", authenticateToken, async (req, res) => {
  try {
    const { brainDump, transcript, selectedModel = 'free', reminderSettings, useOwnApiKey } = req.body;
    
    // Use transcript if brainDump is not provided (for compatibility)
    const content = brainDump || transcript;
    
    console.log('🚀 Task generation request received:');
    console.log('- content:', content ? content.substring(0, 50) + '...' : 'null');
    console.log('- selectedModel:', selectedModel);
    console.log('- reminderSettings:', reminderSettings);
    console.log('- useOwnApiKey:', useOwnApiKey);
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: "Brain dump content is required" });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Determine model and API key based on selection
    let model, userApiKey = null;
    
    switch (selectedModel) {
      case 'free':
        model = 'openai/gpt-4o-mini';
        break;
      case 'premium_openai':
        model = 'openai/gpt-4o-mini';
        userApiKey = user.keys?.openai_api_key;
        break;
      case 'premium_anthropic':
        model = 'anthropic/claude-3-haiku';
        userApiKey = user.keys?.anthropic_api_key;
        break;
      case 'openai4om':
        model = 'openai/gpt-4o-mini';
        break;
      case 'claude3h':
        model = 'anthropic/claude-3-haiku';
        break;
      case 'gemini25':
        model = 'google/gemini-2.5-flash';
        break;
      default:
        model = 'openai/gpt-4o-mini';
    }

    // Get task generation prompt
    const taskPrompt = await BrainPalPrompt.findOne({ 
      name: `brainpal_task_${selectedModel}`,
      isActive: true 
    }) || await BrainPalPrompt.findOne({ 
      name: 'brainpal_task',
      isActive: true 
    });

    const systemPrompt = taskPrompt?.content || 
      "Generate a personalized task list based on the user's brain dump. Focus on actionable, specific tasks.";

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Generate tasks based on this brain dump: ${content}` }
    ];

    // Call OpenRouter API
    const aiResponse = await callOpenRouterAPI(model, messages, userApiKey);
    
    // Track token usage
    await trackTokenUsage(req.user.userId, aiResponse.model, aiResponse.tokensUsed);
    
    // Calculate cost and log API request
    const cost = getOpenRouterCost(aiResponse.tokensUsed, aiResponse.model);
    
    await trackApiRequest(
      req.user.userId,
      user.email,
      'task_generation',
      'openrouter',
      aiResponse.tokensUsed,
      cost,
      'Task generation',
      { model: aiResponse.model, selectedModel }
    );

    // Parse tasks from AI response
    const tasks = parseTasksFromAIResponse(aiResponse.content);
    
    // Create API reminder if reminder settings provided
    if (reminderSettings && reminderSettings.count > 0) {
      console.log('🔔 Creating API reminder with settings:', reminderSettings);
      
      try {
        // Get ApiReminder model
        const ApiReminder = mongoose.model('ApiReminder');
        
        // Calculate timeframe based on reminder settings
        const timeframe = calculateTimeframe(
          reminderSettings.count,
          reminderSettings.startTime,
          reminderSettings.endTime
        );
        
        console.log('🕐 Calculated timeframe:', timeframe);
        
        // Deactivate existing API reminders for this user
        const deactivateResult = await ApiReminder.updateMany(
          { user_id: user._id },
          { isActive: false }
        );
        console.log('🔄 Deactivated existing reminders:', deactivateResult.modifiedCount);
        
        // Create new API reminder
        const apiReminder = new ApiReminder({
          user_id: user._id,
          numberReminders: reminderSettings.count,
          isActive: true,
          reminderName: `Daily Reminders - ${new Date().toLocaleDateString()}`,
          timeframe: timeframe,
          startTime: reminderSettings.startTime,
          endTime: reminderSettings.endTime
        });
        
        await apiReminder.save();
        console.log('✅ API reminder created in apireminders collection:', {
          id: apiReminder._id,
          user_id: user._id,
          numberReminders: reminderSettings.count,
          timeframe: timeframe,
          startTime: reminderSettings.startTime,
          endTime: reminderSettings.endTime
        });
      } catch (apiReminderError) {
        console.error('❌ Failed to create API reminder:', apiReminderError);
        console.error('❌ Reminder settings that failed:', reminderSettings);
        // Don't fail the whole request if API reminder creation fails
      }
    } else {
      console.log('ℹ️ No reminder settings provided or count is 0');
    }

    res.json({
      tasks: tasks,
      model_used: aiResponse.model,
      tokens_used: aiResponse.tokensUsed,
      reminder_saved: !!(reminderSettings && reminderSettings.count > 0)
    });

  } catch (error) {
    console.error('Task generation error:', error);
    res.status(500).json({ error: 'Failed to generate tasks: ' + error.message });
  }
});

// Helper function to parse tasks from AI response
function parseTasksFromAIResponse(aiResponse) {
  const tasks = [];
  const lines = aiResponse.split('\n');
  
  let currentTask = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Main task (starts with number or bullet)
    if (trimmed.match(/^\d+\./) || trimmed.match(/^[\-\*]/)) {
      if (currentTask) {
        tasks.push(currentTask);
      }
      
      currentTask = {
        title: trimmed.replace(/^\d+\.|\-|\*/, '').trim(),
        description: '',
        status: 'pending',
        priority: 'medium',
        subtasks: [],
        created_at: new Date()
      };
    }
    // Subtask (indented)
    else if (trimmed.match(/^\s+[\-\*]/) && currentTask) {
      currentTask.subtasks.push({
        title: trimmed.replace(/^\s+[\-\*]/, '').trim(),
        completed: false
      });
    }
    // Description or continuation
    else if (trimmed && currentTask && !currentTask.description) {
      currentTask.description = trimmed;
    }
  }
  
  if (currentTask) {
    tasks.push(currentTask);
  }
  
  return tasks;
}

// Helper function to calculate timeframe for API reminders
function calculateTimeframe(numberReminders, startTime, endTime) {
  if (numberReminders <= 0) return [];
  
  // If only 1 reminder, just return the start time
  if (numberReminders === 1) {
    return [startTime];
  }
  
  // Parse start and end times
  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour, endMin] = endTime.split(':').map(Number);
  
  // Convert to minutes from midnight
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;
  
  // Calculate interval between reminders
  const totalMinutes = endMinutes - startMinutes;
  const interval = totalMinutes / (numberReminders - 1);
  
  // Generate timeframe array
  const timeframe = [];
  for (let i = 0; i < numberReminders; i++) {
    const reminderMinutes = startMinutes + (i * interval);
    const hour = Math.floor(reminderMinutes / 60);
    const minute = Math.round(reminderMinutes % 60);
    
    // Format as HH:MM
    const timeString = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    timeframe.push(timeString);
  }
  
  return timeframe;
}
