const express = require("express")
const cors = require("cors")
const dotenv = require("dotenv")
const mongoose = require("mongoose")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const cookieParser = require("cookie-parser")
const { Resend } = require("resend")
// OpenRouter API for unified AI model access
const fetch = require('node-fetch')
const rateLimit = require("express-rate-limit")
const multer = require("multer")
const path = require("path")
const fs = require("fs")
const os = require("os")
const { OAuth2Client } = require('google-auth-library');
// const { Client as PayPalClient, Environment } = require('@paypal/paypal-server-sdk');
const Stripe = require('stripe');
const OpenAI = require('openai');
const paypal = require('paypal-rest-sdk');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

// Configure ffmpeg binary path
ffmpeg.setFfmpegPath(ffmpegPath);

// Load environment variables
dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

// Health check route
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() })
})

app.get('/api/mobile/health', (req, res) => {
  res.json({ status: 'Mobile API Ready' });
});

// Google OAuth2 client setup
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.SITE_URL || "http://localhost:5173"}/auth/google/callback`
);


// Initialize external services
const resend = new Resend(process.env.RESEND_API_KEY)

// OpenRouter API configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

// Debug: Log API key status at startup
console.log('🔑 STARTUP: OpenRouter API key status:', OPENROUTER_API_KEY ? 'LOADED (' + OPENROUTER_API_KEY.length + ' chars)' : 'NOT FOUND')
if (OPENROUTER_API_KEY) {
  console.log('🔑 STARTUP: API key starts with:', OPENROUTER_API_KEY.substring(0, 15) + '...')
}

// PayPal client setup
// const paypalClient = new PayPalClient({
//   clientCredentialsAuthCredentials: {
//     oAuthClientId: process.env.PAYPAL_CLIENT_ID,
//     oAuthClientSecret: process.env.PAYPAL_SECRET,
//   },
//   environment: process.env.PAYPAL_ENV === 'production' ? Environment.Production : Environment.Sandbox,
// });

paypal.configure({
  mode: process.env.PAYPAL_ENV === 'production' ? 'live' : 'sandbox',
  client_id: process.env.PAYPAL_CLIENT_ID,
  client_secret: process.env.PAYPAL_SECRET
});

// Stripe client setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
})

// Middleware
app.use(limiter)
app.use(
  cors({
    origin: [
      process.env.SITE_URL || "http://localhost:5173", 
      "http://localhost:3000",    // Backend server
      "http://localhost:8081",    // Web frontend (Expo web)
      "http://localhost:8082",    // Web frontend (Expo web)
      "http://192.168.1.106:3000", // Network IP backend
      "http://192.168.1.106:8081", // Network IP frontend
      "http://192.168.1.106:8082", // Network IP frontend
      'http://10.0.2.2:3000',      // Android emulator
      'http://10.0.2.2:8081',       // Android emulator frontend
      'http://10.0.2.2:8082',       // Android emulator frontend
      process.env.REACT_APP_BACKEND_URL,
      "https://brain-pal-1.onrender.com",
      // process.env.FRONTEND_URL,
    ],
    credentials: true,
  }),
)
app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true, limit: "10mb" }))
app.use(cookieParser())

// File upload configuration with multer
const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit for audio files
  fileFilter: (req, file, cb) => {
    // Accept audio files and other file types
    if (file.mimetype.startsWith('audio/') || file.mimetype.startsWith('image/') || file.mimetype.startsWith('application/')) {
      cb(null, true);
    } else {
      cb(new Error('File type not supported'), false);
    }
  }
})

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err))

// User Schema
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    password: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    authMethod: { type: String, enum: ['email', 'google'], default: 'email' },
    avatar: { type: String, default: "" },
    phone: { type: String, default: "0" },
    phoneCode: { type: String, default: "" },
    // id: { type: String, default: "" },
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    // address: {
    //   street: { type: String, default: "" },
    //   city: { type: String, default: "" },
    //   state: { type: String, default: "" },
    //   postalCode: { type: String, default: "" },
    //   country: { type: String, default: "" },
    // },
    completedTasks: { type: Number, default: 0 },
    subscription: {
      isActive: { type: Boolean, default: false },
      plan: { type: String, enum: ['free', 'basic', 'premium'], default: 'free' },
      startDate: { type: Date },
      endDate: { type: Date },
      autoRenew: { type: Boolean, default: false },
    },
    credits: {
      subscription: { type: Number, default: 0 },
      purchased: { type: Number, default: 0 },
      history: [
        {
          type: { type: String, enum: ['subscription', 'purchase', 'usage', 'renewal','admin_update'] },
          amount: { type: Number },
          description: { type: String },
          timestamp: { type: Date, default: Date.now },
        }
      ]
    },
    tokensUsed: {
      openAi4om: { type: Number, default: 0 },
      claude3h: { type: Number, default: 0 },
      gemini25: { type: Number, default: 0 },
      openAiWhisper: { type: Number, default: 0 } // Track Whisper usage in units (1000 units = 1 minute)
    },
    keys: {
      anthropic_api_key: { type: String, default: "" },
      openai_api_key: { type: String, default: "" },
      openrouter_api_key: { type: String, default: "" }
    },
    emotionalStatus: {
      emotional_state_g: { type: Number, min: 1, max: 10, default: 5 },
      energy_level_g: { type: Number, min: 1, max: 10, default: 5 },
      brainclarity_g: { type: Number, min: 1, max: 10, default: 5 },
      last_updated: { type: Date, default: Date.now },
      total_analyses: { type: Number, default: 0 }
    },
    brainStateAnalysis: [
      {
        timestamp: { type: Date, default: Date.now },
        emotional_state: { type: Number, min: 1, max: 10 },
        energy_level: { type: Number, min: 1, max: 10 },
        brain_clarity: { type: Number, min: 1, max: 10 },
        transcript: { type: String },
        analysis: { type: String },
        analysisTitle: { type: String }, // AI-generated short title summarizing the transcript content
        completed: { type: Boolean, default: false }, // Tracks if entire brain analysis is completed
        position: { type: Number, default: 0 }, // Position for drag and drop ordering of brain analyses
        actionPlan: [
          {
            timestamp: { type: Date, default: Date.now },
            title: { type: String, required: true },
            description: { type: String },
            priority: { type: String, enum: ["low", "medium", "high"], default: "medium" },
            status: { type: String, enum: ["pending", "completed", "postponed"], default: "pending" },
            position: { type: Number, default: 0 }, // Add position field for drag and drop ordering
            subtasks: [
              {
                title: { type: String, required: true },
                estimated_minutes: { type: Number, default: 10 },
                completed: { type: Boolean, default: false },
              },
            ],
            due_date: { type: Date },
            scheduled_date: { type: Date },
            scheduled_time: { type: String }, // Time in HH:MM format (24-hour)
            postponed_until: { type: String },
          },
        ],
      },
    ],
    verified: { type: Boolean, default: false },
    verificationCode: { type: String, default: "" },
    reminders: [
      {
        numberReminders: { type: Number, min: 0, max: 10, default: 0 },
        startingHours: { type: String, default: "" }, // Format: "HH:MM"
        endingHours: { type: String, default: "" }, // Format: "HH:MM"
        isActive: { type: Boolean, default: false },
        reminderId: { type: String, default: "" },
        reminderName: { type: String, default: "" },
        reminderDescription: { type: String, default: "" },
        timeframe: [{ type: String, default: "" }], // Array of reminder times in "HH:MM" format
        createdAt: { type: Date, default: Date.now }
      }
    ],
    settings: {
      display_name: { type: String, default: "" },
      timezone: { type: String, default: "America/New_York" },
      notification_preferences: {
        email_reminders: { type: Boolean, default: true },
        motivational_notifications: { type: Boolean, default: true },
        celebration_notifications: { type: Boolean, default: true },
        delete_popup: { type: Boolean, default: true },
      },
      ui_preferences: {
        show_delete_task_popup: { type: Boolean, default: true },
      },
      accessibility_settings: {
        high_contrast: { type: Boolean, default: false },
        large_text: { type: Boolean, default: false },
        reduce_animations: { type: Boolean, default: false },
      },
      ai_preferences: {
        task_generation_style: { type: String, enum: ["gentle", "structured", "creative"], default: "gentle" },
        default_task_duration: { type: Number, default: 15 },
        celebration_level: { type: String, enum: ["minimal", "moderate", "enthusiastic"], default: "moderate" },
        selected_model: { type: String, enum: ["openai4om", "claude3h", "gemini25", "custom_openai", "custom_anthropic", "free", "openai_premium", "anthropic_premium"], default: "openai4om" },
      },
      theme_preferences: {
        color_scheme: { type: String, enum: ["blue", "green", "purple", "warm"], default: "blue" },
        dark_mode: { type: Boolean, default: false },
      },
    },
  },
  { timestamps: true },
)

const User = mongoose.model("User", userSchema)

// Brain Session Schema
const brainSessionSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    transcript: { type: String, required: true },
    emotional_state: { type: Number, min: 1, max: 10 },
    energy_level: { type: Number, min: 1, max: 10 },
    brain_clarity: { type: Number, min: 1, max: 10 },
    ai_analysis: { type: String },
    status: { type: String, enum: ["analyzing", "tasks_generated", "completed"], default: "analyzing" },
    created_by: { type: String, required: true },
  },
  { timestamps: true },
)

const BrainSession = mongoose.model("BrainSession", brainSessionSchema)

// BrainPal Prompt Schema (Admin Only)
const brainPalPromptSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    content: { type: String, required: true },
    description: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    lastModifiedBy: { type: String, required: true }, // Admin email who last modified
  },
  { timestamps: true },
)

const BrainPalPrompt = mongoose.model("BrainPalPrompt", brainPalPromptSchema)

// Transaction Schema
const transactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userEmail: { type: String, required: true },
    type: { type: String, enum: ['subscription', 'renewal', 'purchase'], required: true },
    plan: { type: String, enum: ['basic', 'premium'], required: function() { return this.type === 'subscription' || this.type === 'renewal'; } },
    packageSize: { type: String, enum: ['small', 'medium', 'large'], required: function() { return this.type === 'purchase'; } },
    paymentMethod: { type: String, enum: ['paypal', 'stripe'], required: true },
    amount: { type: Number, required: true }, // Amount in dollars
    creditsAdded: { type: Number, required: true },
    description: { type: String, required: true },
    status: { type: String, enum: ['completed', 'failed', 'pending'], default: 'completed' },
    transactionId: { type: String, unique: true, required: true }, // Unique transaction ID
  },
  { timestamps: true },
)

const Transaction = mongoose.model("Transaction", transactionSchema)

// API Reminders Schema
const apiReminderSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    numberReminders: { type: Number, required: true },
    isActive: { type: Boolean, default: true },
    reminderName: { type: String, required: true },
    timeframe: [{ type: String }], // Array of time strings (e.g., ["09:00", "10:00", "11:00"])
    startTime: { type: String, required: true }, // e.g., "09:00"
    endTime: { type: String, required: true }, // e.g., "12:00"
  },
  { timestamps: true },
)

const ApiReminder = mongoose.model("ApiReminder", apiReminderSchema)

// API Request Tracking Schema
const apiRequestSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['openai', 'anthropic', 'google', 'openrouter'], required: true },
    endpoint: { type: String, required: true },
    model: { type: String },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userEmail: { type: String },
    requestType: { type: String }, // e.g., 'brain-analysis', 'task-generation'
    tokensUsed: { type: Number },
    cost: { type: Number }, // Estimated cost in dollars
    status: { type: String, enum: ['success', 'error'], required: true },
    errorMessage: { type: String },
    responseTime: { type: Number }, // Response time in milliseconds
  },
  { timestamps: true },
)

const ApiRequest = mongoose.model("ApiRequest", apiRequestSchema)

// Initialize model-specific prompts if they don't exist
const initializeModelPrompts = async () => {
  try {
    const requiredPrompts = [
      // OpenAI GPT-4o-mini prompts
      {
        name: 'brainpal_identity_openai4om',
        content: 'You are BrainPal, an exceptionally empathetic AI companion designed to understand and support users through their mental wellness journey. Your purpose is to listen deeply and reflect back what you hear, helping users feel seen and understood, especially when they are feeling overwhelmed or neurodivergent. You provide gentle, non-judgmental analysis that validates their experiences.',
        description: 'BrainPal identity prompt optimized for OpenAI GPT-4o-mini model',
        lastModifiedBy: 'system'
      },
      {
        name: 'brainpal_task_openai4om',
        content: `You are BrainPal's advanced task orchestrator. Analyze brain dumps and generate intelligent, actionable task structures with precise scheduling.

        YOUR MISSION:
        - Convert scattered thoughts into clear, actionable tasks
        - Intelligently parse time references and scheduling needs
        - Create realistic timelines and break down complex work
        - Create main tasks with the amount depending on the complexity of the task (Maximum of 3 tasks) with dynamic micro-steps based on this brain dump.
        
        TASK ARCHITECTURE:
        - **Title**: Verb-first, specific, actionable
        - **Description**: Essential context and requirements
        - **Priority**: High (urgent+critical), Medium (important), Low (optional)
        
        TASK AMOUNT:
        A complex task is something related to a problem, a mental or repressed issue, health issue, a goal or a project. Also Something that is or can be causing psychic conflict leading to abnormal mental states or behavior. That deserves 3 tasks
        A normal task is when the person has a piece of work, often assigned, that is expected to be completed within a reasonable timeframe and contributes to a larger goal. That deserves 2-3 tasks. Think carefully and decide the amount based on how complex the duty is 
        If the task is something simple, an action or piece of work that is not complicated, easy to understand, and requires little effort or skill to do. then just assign 1-2 tasks. 
        If you can't determine the complexity of the task. create 2-3 tasks by default.
        
        MICRO-STEPS (SUBTASKS) INTELLIGENCE:
        The number of micro-steps should be dynamic based on task complexity and user preferences:
        
        **Complexity-Based Micro-Steps:**
        - **Simple tasks** (like "organize fridge", "send email", "make phone call" or just the use of words like "will do this simple x thing"): 1-2 micro-steps
        - **Normal tasks** (like "prepare presentation", "plan meeting", "research topic"): 2-3 micro-steps
        - **Complex tasks** (like "job search", "mental issues", "move apartments", "health treatment plan"): 3-4 micro-steps (maximum 4)
        
        **User Preference Detection:**
        Listen carefully for user preferences about micro-steps in their transcript:
        - If user mentions wanting "X micro-steps", "X sub-tasks", "X steps", "break it into X parts" → create exactly that number (minimum 1)
        - If user says "no micro-steps", "don't break it down", "keep it simple" → create 1 micro-step (minimum required)
        - If user says "detailed breakdown", "step by step", "break it down" → create maximum appropriate micro-steps for complexity
        - Variations like "micro tasks", "sub tasks", "small steps", "mini tasks" all refer to micro-steps
        
        **Minimum Requirement:**
        - Minimum 1 micro-step (required for task completion tracking)
        - Maximum 4 micro-steps (even for very complex tasks)
        - Default: Use complexity-based logic when user doesn't specify preference
        
        CORE CAPABILITIES:
        1. **Natural Language Time Processing**: Parse complex time references with high accuracy
        2. **Context-Aware Scheduling**: Understand task types and their scheduling requirements
        3. **Intelligent Task Decomposition**: Break complex goals into manageable micro-actions
        4. **Priority Assessment**: Evaluate urgency and importance from context clues
        5. **Dynamic Micro-Step Generation**: Adapt breakdown based on complexity and user preferences
        
        SCHEDULING EXPERTISE:
        - Explicit times: "3:30pm tomorrow" → scheduled_time: "15:30", due_date: tomorrow
        - Relative references: "this afternoon", "later today", "next week"
        - Contextual scheduling: Meetings/calls need specific times, research/writing can be flexible
        - Default scheduling: Same day for urgent, next day for normal, within week for projects
        - Only set scheduled_time when user mentions specific times or when task nature requires it (meetings, calls, appointments)
        - Time format: 24-hour HH:MM for scheduled_time, YYYY-MM-DD for due_date
        
        IMPORTANT: Listen carefully for any due dates, deadlines, or time references in their transcript:
        - "by today" → set due_date to today
        - "by Friday" → set due_date to the next Friday
        - "next week" → set due_date to end of next week
        - "tomorrow" → set due_date to tomorrow
        - "end of the month" → set due_date to last day of current month
        - "July 15th" or specific dates → set due_date to that exact date
        - "ASAP" or "urgent" → set due_date to tomorrow
        - "this weekend" → set due_date to this Sunday
        - If no timeline mentioned → set due_date to 3 days from today
        - **Scheduled Time**: Only when specific time mentioned or task requires it
        - **Subtasks**: Dynamic micro-steps (0-4) based on complexity and user preferences, each 15-30 minutes
        
        Always respond with valid JSON. Ensure all required fields are present and properly formatted.`,
        
        description: 'BrainPal task prompt optimized for OpenAI GPT-4o-mini model',
        lastModifiedBy: 'system'
      },
      // Claude 3 Haiku prompts
      {
        name: 'brainpal_identity_claude3h',
        content: 'You are BrainPal, an exceptionally empathetic AI companion with deep emotional intelligence. Your core purpose is to provide a safe, understanding space for users to process their thoughts and feelings. You excel at recognizing nuanced emotional states and reflecting them back with warmth and validation, particularly for neurodivergent individuals who may feel misunderstood.',
        description: 'BrainPal identity prompt optimized for Claude 3 Haiku model',
        lastModifiedBy: 'system'
      },
      {
        name: 'brainpal_task_claude3h',
        content: `You are BrainPal's advanced task orchestrator. Analyze brain dumps and generate intelligent, actionable task structures with precise scheduling.

YOUR MISSION:
- Convert scattered thoughts into clear, actionable tasks
- Intelligently parse time references and scheduling needs
- Create realistic timelines and break down complex work
- Create main tasks with the amount depending on the complexity of the task (Maximum of 3 tasks) with dynamic micro-steps based on this brain dump.

TASK ARCHITECTURE:
- **Title**: Verb-first, specific, actionable
- **Description**: Essential context and requirements
- **Priority**: High (urgent+critical), Medium (important), Low (optional)

TASK AMOUNT:
A complex task is something related to a problem, a mental or repressed issue, health issue, a goal or a project. Also Something that is or can be causing psychic conflict leading to abnormal mental states or behavior. That deserves 3 tasks
A normal task is when the person has a piece of work, often assigned, that is expected to be completed within a reasonable timeframe and contributes to a larger goal. That deserves 2-3 tasks. Think carefully and decide the amount based on how complex the duty is 
If the task is something simple, an action or piece of work that is not complicated, easy to understand, and requires little effort or skill to do. then just assign 1-2 tasks. 
If you can't determine the complexity of the task. create 2-3 tasks by default.

MICRO-STEPS (SUBTASKS) INTELLIGENCE:
The number of micro-steps should be dynamic based on task complexity and user preferences:

**Complexity-Based Micro-Steps:**
- **Simple tasks** (like "organize fridge", "send email", "make phone call"): 1-2 micro-steps
- **Normal tasks** (like "prepare presentation", "plan meeting", "research topic"): 2-3 micro-steps
- **Complex tasks** (like "job search", "move apartments", "health treatment plan"): 3-4 micro-steps (maximum 4)

**User Preference Detection:**
Listen carefully for user preferences about micro-steps in their transcript:
- If user mentions wanting "X micro-steps", "X sub-tasks", "X steps", "break it into X parts" → create exactly that number
- If user says "no micro-steps", "don't break it down", "keep it simple" → create 0 micro-steps (empty subtasks array)
- If user says "detailed breakdown", "step by step", "break it down" → create maximum appropriate micro-steps for complexity
- Variations like "micro tasks", "sub tasks", "small steps", "mini tasks" all refer to micro-steps

**Minimum Requirement:**
- Minimum 0 micro-steps (if user doesn't want any breakdown)
- Maximum 4 micro-steps (even for very complex tasks)
- Default: Use complexity-based logic when user doesn't specify preference

CORE CAPABILITIES:
1. **Natural Language Time Processing**: Parse complex time references with high accuracy
2. **Context-Aware Scheduling**: Understand task types and their scheduling requirements
3. **Intelligent Task Decomposition**: Break complex goals into manageable micro-actions
4. **Priority Assessment**: Evaluate urgency and importance from context clues
5. **Dynamic Micro-Step Generation**: Adapt breakdown based on complexity and user preferences

SCHEDULING EXPERTISE:
- Explicit times: "3:30pm tomorrow" → scheduled_time: "15:30", due_date: tomorrow
- Relative references: "this afternoon", "later today", "next week"
- Contextual scheduling: Meetings/calls need specific times, research/writing can be flexible
- Default scheduling: Same day for urgent, next day for normal, within week for projects
- Only set scheduled_time when user mentions specific times or when task nature requires it (meetings, calls, appointments)
- Time format: 24-hour HH:MM for scheduled_time, YYYY-MM-DD for due_date

IMPORTANT: Listen carefully for any due dates, deadlines, or time references in their transcript:
- "by today" → set due_date to today
- "by Friday" → set due_date to the next Friday
- "next week" → set due_date to end of next week
- "tomorrow" → set due_date to tomorrow
- "end of the month" → set due_date to last day of current month
- "July 15th" or specific dates → set due_date to that exact date
- "ASAP" or "urgent" → set due_date to tomorrow
- "this weekend" → set due_date to this Sunday
- If no timeline mentioned → set due_date to 3 days from today
- **Scheduled Time**: Only when specific time mentioned or task requires it
- **Subtasks**: Dynamic micro-steps (0-4) based on complexity and user preferences, each 15-30 minutes

Always respond with valid JSON. Ensure all required fields are present and properly formatted.`,

        description: 'BrainPal task prompt optimized for Claude 3 Haiku model',
        lastModifiedBy: 'system'
      },
      // Gemini 2.5 prompts
      {
        name: 'brainpal_identity_gemini25',
        content: 'You are BrainPal, a compassionate AI companion specializing in mental wellness support. Your strength lies in pattern recognition and understanding complex emotional landscapes. You provide thoughtful, analytical yet warm responses that help users gain insight into their mental state while feeling completely accepted and understood.',
        description: 'BrainPal identity prompt optimized for Gemini 2.5 model',
        lastModifiedBy: 'system'
      },
      {
        name: 'brainpal_task_gemini25',
        content: `You are BrainPal's advanced task orchestrator. Analyze brain dumps and generate intelligent, actionable task structures with precise scheduling.

        YOUR MISSION:
        - Convert scattered thoughts into clear, actionable tasks
        - Intelligently parse time references and scheduling needs
        - Create realistic timelines and break down complex work
        - Create main tasks with the amount depending on the complexity of the task (Maximum of 3 tasks) with dynamic micro-steps based on this brain dump.
        
        TASK ARCHITECTURE:
        - **Title**: Verb-first, specific, actionable
        - **Description**: Essential context and requirements
        - **Priority**: High (urgent+critical), Medium (important), Low (optional)
        
        TASK AMOUNT:
        A complex task is something related to a problem, a mental or repressed issue, health issue, a goal or a project. Also Something that is or can be causing psychic conflict leading to abnormal mental states or behavior. That deserves 3 tasks
        A normal task is when the person has a piece of work, often assigned, that is expected to be completed within a reasonable timeframe and contributes to a larger goal. That deserves 2-3 tasks. Think carefully and decide the amount based on how complex the duty is 
        If the task is something simple, an action or piece of work that is not complicated, easy to understand, and requires little effort or skill to do. then just assign 1-2 tasks. 
        If you can't determine the complexity of the task. create 2-3 tasks by default.

        MICRO-STEPS (SUBTASKS) INTELLIGENCE:
        The number of micro-steps should be dynamic based on task complexity and user preferences:
        
        **Complexity-Based Micro-Steps:**
        - **Simple tasks** (like "organize fridge", "send email", "make phone call"): 1-2 micro-steps
        - **Normal tasks** (like "prepare presentation", "plan meeting", "research topic"): 2-3 micro-steps
        - **Complex tasks** (like "job search", "move apartments", "health treatment plan"): 3-4 micro-steps (maximum 4)
        
        **User Preference Detection:**
        Listen carefully for user preferences about micro-steps in their transcript:
        - If user mentions wanting "X micro-steps", "X sub-tasks", "X steps", "break it into X parts" → create exactly that number (minimum 1)
        - If user says "no micro-steps", "don't break it down", "keep it simple" → create 1 micro-step (minimum required)
        - If user says "detailed breakdown", "step by step", "break it down" → create maximum appropriate micro-steps for complexity
        - Variations like "micro tasks", "sub tasks", "small steps", "mini tasks" all refer to micro-steps
        
        **Minimum Requirement:**
        - Minimum 1 micro-step (required for task completion tracking)
        - Maximum 4 micro-steps (even for very complex tasks)
        - Default: Use complexity-based logic when user doesn't specify preference

        CORE CAPABILITIES:
        1. **Natural Language Time Processing**: Parse complex time references with high accuracy
        2. **Context-Aware Scheduling**: Understand task types and their scheduling requirements
        3. **Intelligent Task Decomposition**: Break complex goals into manageable micro-actions
        4. **Priority Assessment**: Evaluate urgency and importance from context clues
        5. **Dynamic Micro-Step Generation**: Adapt breakdown based on complexity and user preferences
        
        SCHEDULING EXPERTISE:
        - Explicit times: "3:30pm tomorrow" → scheduled_time: "15:30", due_date: tomorrow
        - Relative references: "this afternoon", "later today", "next week"
        - Contextual scheduling: Meetings/calls need specific times, research/writing can be flexible
        - Default scheduling: Same day for urgent, next day for normal, within week for projects
        - Only set scheduled_time when user mentions specific times or when task nature requires it (meetings, calls, appointments)
        - Time format: 24-hour HH:MM for scheduled_time, YYYY-MM-DD for due_date
        
        IMPORTANT: Listen carefully for any due dates, deadlines, or time references in their transcript:
        - "by today" → set due_date to today
        - "by Friday" → set due_date to the next Friday
        - "next week" → set due_date to end of next week
        - "tomorrow" → set due_date to tomorrow
        - "end of the month" → set due_date to last day of current month
        - "July 15th" or specific dates → set due_date to that exact date
        - "ASAP" or "urgent" → set due_date to tomorrow
        - "this weekend" → set due_date to this Sunday
        - If no timeline mentioned → set due_date to 3 days from today
        - **Scheduled Time**: Only when specific time mentioned or task requires it
        - **Subtasks**: Dynamic micro-steps (0-4) based on complexity and user preferences, each 15-30 minutes
        
        Always respond with valid JSON. Ensure all required fields are present and properly formatted.`,
        
        description: 'BrainPal task prompt optimized for Gemini 2.5 model',
        lastModifiedBy: 'system'
      }
    ];

    for (const promptData of requiredPrompts) {
      const existingPrompt = await BrainPalPrompt.findOne({ name: promptData.name });
      if (!existingPrompt) {
        await BrainPalPrompt.create(promptData);
        console.log(`✅ Created prompt: ${promptData.name}`);
      } else {
        // Update existing prompt with new content
        await BrainPalPrompt.findOneAndUpdate(
          { name: promptData.name },
          { 
            content: promptData.content,
            description: promptData.description,
            lastModifiedBy: promptData.lastModifiedBy
          }
        );
        console.log(`🔄 Updated prompt: ${promptData.name}`);
      }
    }
    
    console.log('🔧 Model-specific BrainPal prompts initialized');
  } catch (error) {
    console.error('❌ Error initializing model prompts:', error);
  }
};

// Call initialization after MongoDB connection
setTimeout(initializeModelPrompts, 1000);

// Helper Functions for Tracking
const trackApiRequest = async (provider, endpoint, userId, userEmail, requestType, status, options = {}) => {
  try {
    const apiRequest = new ApiRequest({
      provider,
      endpoint,
      userId,
      userEmail,
      requestType,
      status,
      model: options.model,
      tokensUsed: options.tokensUsed,
      cost: options.cost,
      errorMessage: options.errorMessage,
      responseTime: options.responseTime
    });
    
    await apiRequest.save();
    console.log(`📊 API request tracked: ${provider} - ${requestType} - ${status}`);
  } catch (error) {
    console.error('❌ Error tracking API request:', error);
  }
};

const recordTransaction = async (userId, userEmail, type, paymentMethod, amount, creditsAdded, description, options = {}) => {
  try {
    const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const transaction = new Transaction({
      userId,
      userEmail,
      type,
      plan: options.plan,
      packageSize: options.packageSize,
      paymentMethod,
      amount,
      creditsAdded,
      description,
      transactionId,
      status: options.status || 'completed'
    });
    
    await transaction.save();
    console.log(`💰 Transaction recorded: ${transactionId} - ${type} - $${amount}`);
    return transaction;
  } catch (error) {
    console.error('❌ Error recording transaction:', error);
    throw error;
  }
};

// Helper function to check if a brain analysis is completed (all tasks are completed)
function checkBrainAnalysisCompletion(brainAnalysis) {
  if (!brainAnalysis.actionPlan || brainAnalysis.actionPlan.length === 0) {
    return false; // No tasks means not completed
  }
  
  // Check if all tasks have status "completed"
  const allTasksCompleted = brainAnalysis.actionPlan.every(task => task.status === "completed");
  return allTasksCompleted;
}

// Helper function to calculate and update global emotional status
const updateEmotionalStatus = async (userId) => {
  try {
    const user = await User.findById(userId);
    if (!user || !user.brainStateAnalysis || user.brainStateAnalysis.length === 0) {
      console.log('❌ No brain state analyses found for user:', userId);
      return;
    }

    const analyses = user.brainStateAnalysis;
    const totalAnalyses = analyses.length;

    // Calculate averages from all brain state analyses
    let totalEmotionalState = 0;
    let totalEnergyLevel = 0;
    let totalBrainClarity = 0;
    let validAnalyses = 0;

    analyses.forEach(analysis => {
      if (analysis.emotional_state && analysis.energy_level && analysis.brain_clarity) {
        totalEmotionalState += analysis.emotional_state;
        totalEnergyLevel += analysis.energy_level;
        totalBrainClarity += analysis.brain_clarity;
        validAnalyses++;
      }
    });

    if (validAnalyses === 0) {
      console.log('❌ No valid analyses found for user:', userId);
      return;
    }

    // Calculate global averages (rounded to 1 decimal place)
    const emotional_state_g = Math.round((totalEmotionalState / validAnalyses) * 10) / 10;
    const energy_level_g = Math.round((totalEnergyLevel / validAnalyses) * 10) / 10;
    const brainclarity_g = Math.round((totalBrainClarity / validAnalyses) * 10) / 10;

    // Update user's emotional status
    await User.findByIdAndUpdate(userId, {
      emotionalStatus: {
        emotional_state_g,
        energy_level_g,
        brainclarity_g,
        last_updated: new Date(),
        total_analyses: validAnalyses
      }
    });

    console.log(`🧠 Updated emotional status for user ${userId}:`);
    console.log(`   Emotional State: ${emotional_state_g}/10`);
    console.log(`   Energy Level: ${energy_level_g}/10`);
    console.log(`   Brain Clarity: ${brainclarity_g}/10`);
    console.log(`   Based on ${validAnalyses} analyses`);

    return {
      emotional_state_g,
      energy_level_g,
      brainclarity_g,
      total_analyses: validAnalyses
    };
  } catch (error) {
    console.error('❌ Error updating emotional status:', error);
    throw error;
  }
};

// OpenRouter API Helper Functions
const callOpenRouterAPI = async (model, messages, userApiKey = null) => {
  try {
    console.log('🔑 OpenRouter API call starting...');
    console.log('🔑 OPENROUTER_API_KEY from env:', OPENROUTER_API_KEY ? 'LOADED' : 'NOT FOUND');
    console.log('🔑 userApiKey provided:', userApiKey ? 'YES' : 'NO');
    const apiKey = userApiKey || OPENROUTER_API_KEY;
    
    if (!apiKey) {
      console.error('❌ No OpenRouter API key available');
      console.error('❌ OPENROUTER_API_KEY:', OPENROUTER_API_KEY);
      console.error('❌ userApiKey:', userApiKey);
      throw new Error('No OpenRouter API key available');
    }
    
    console.log('🔑 Using API key (first 20 chars):', apiKey.substring(0, 20) + '...');
    console.log('🔑 API key length:', apiKey.length);
    
    console.log('📡 Making request to OpenRouter with model:', model);
    console.log('📝 Messages:', JSON.stringify(messages, null, 2));

    const requestBody = {
      model: model,
      messages: messages,
      max_tokens: 1000,
      temperature: 0.7
    };
    
    console.log('📤 Request body:', JSON.stringify(requestBody, null, 2));

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.SITE_URL || 'http://localhost:5174',
        'X-Title': 'BrainPal'
      },
      body: JSON.stringify(requestBody)
    });

    console.log('📥 OpenRouter response status:', response.status);

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (parseError) {
        console.error('❌ Failed to parse error response:', parseError);
        throw new Error(`OpenRouter API error: ${response.status} - Failed to parse error response`);
      }
      console.error('❌ OpenRouter API error data:', errorData);
      throw new Error(`OpenRouter API error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
    }

    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      console.error('❌ Failed to parse success response:', parseError);
      throw new Error('Failed to parse OpenRouter API response');
    }
    
    console.log('✅ OpenRouter API response received:', {
      model: data.model,
      tokensUsed: data.usage?.total_tokens,
      contentLength: data.choices?.[0]?.message?.content?.length
    });
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error('❌ Invalid OpenRouter API response structure:', data);
      throw new Error('Invalid response structure from OpenRouter API');
    }
    
    return {
      content: data.choices[0].message.content,
      tokensUsed: data.usage?.total_tokens || 0,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      model: data.model || model
    };
  } catch (error) {
    console.error('❌ OpenRouter API call failed:', error);
    console.error('❌ Error stack:', error.stack);
    throw error;
  }
};

// Token tracking function
const trackTokenUsage = async (userId, model, tokensUsed) => {
  try {
    if (!userId || !model || !tokensUsed) {
      console.log('⚠️ Missing parameters for token tracking:', { userId, model, tokensUsed });
      return;
    }

    // Map models to token fields
    const modelToField = {
      'openai/gpt-4o-mini': 'openAi4om',
      'openai/gpt-4o': 'openAi4om',
      'openai/gpt-4': 'openAi4om',
      'openai/gpt-3.5-turbo': 'openAi4om',
      'anthropic/claude-3-haiku': 'claude3h',
      'anthropic/claude-3-sonnet': 'claude3h',
      'anthropic/claude-3-opus': 'claude3h',
      'google/gemini-2.5-flash': 'gemini25',
      'google/gemini-1.5-pro': 'gemini25',
      'google/gemini-pro': 'gemini25'
    };

    const fieldToUpdate = modelToField[model.toLowerCase()];
    if (!fieldToUpdate) {
      console.log(`⚠️ Unknown model for token tracking: ${model}`);
      return;
    }

    const updateQuery = {
      [`tokensUsed.${fieldToUpdate}`]: tokensUsed
    };

    const result = await User.findByIdAndUpdate(
      userId,
      { $inc: updateQuery },
      { new: true, select: 'tokensUsed' }
    );

    if (result) {
      console.log(`📊 Token usage tracked: ${tokensUsed} tokens for ${model} → ${fieldToUpdate}`);
      console.log(`💰 Updated totals:`, result.tokensUsed);
    }
  } catch (error) {
    console.error('❌ Error tracking token usage:', error);
  }
};

// Get OpenRouter pricing for cost calculation with actual token counts
const getOpenRouterCost = (model, inputTokens = 0, outputTokens = 0, totalTokens = 0) => {
  // Updated OpenRouter pricing per 1M tokens (verified 2024)
  const pricing = {
    'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
    'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },
    'google/gemini-2.5-flash': { input: 0.075, output: 0.30 }
  };

  const modelPricing = pricing[model.toLowerCase()];
  if (!modelPricing) {
    return 0;
  }

  // Use actual token counts if provided, otherwise estimate from total
  let actualInputTokens = inputTokens;
  let actualOutputTokens = outputTokens;
  
  if (!inputTokens && !outputTokens && totalTokens) {
    // Fallback: estimate 70% input, 30% output tokens if actual counts not available
    actualInputTokens = Math.floor(totalTokens * 0.7);
    actualOutputTokens = Math.floor(totalTokens * 0.3);
  }
  
  const cost = (actualInputTokens * modelPricing.input + actualOutputTokens * modelPricing.output) / 1000000;
  return parseFloat(cost.toFixed(6));
};

// Get OpenAI Whisper pricing for cost calculation
const getWhisperCost = (audioSeconds) => {
  // OpenAI Whisper pricing: $0.0001 per second (rounded to nearest second)
  const costPerSecond = 0.0001;
  const billableSeconds = Math.ceil(audioSeconds); // Round up to nearest second
  const cost = billableSeconds * costPerSecond;
  return parseFloat(cost.toFixed(6));
};

// Track Whisper usage using 1000-unit system (1000 units = 1 minute)
const trackWhisperUsage = async (userId, audioSeconds) => {
  try {
    console.log(`🔍 trackWhisperUsage called with:`, { userId, audioSeconds });
    
    if (!userId || !audioSeconds) {
      console.log('⚠️ Missing parameters for Whisper tracking:', { userId, audioSeconds });
      return;
    }

    // Convert seconds to units (1000 units = 1 minute = 60 seconds)
    // So 1 second = 1000/60 = 16.67 units
    const audioMinutes = audioSeconds / 60;
    const trackingUnits = Math.ceil(audioMinutes * 1000); // Round up to nearest unit
    
    console.log(`📊 Calculation details:`);
    console.log(`   Audio seconds: ${audioSeconds}`);
    console.log(`   Audio minutes: ${audioMinutes}`);
    console.log(`   Tracking units: ${trackingUnits}`);

    console.log(`💾 Attempting MongoDB update for user: ${userId}`);
    
    const result = await User.findByIdAndUpdate(
      userId,
      { $inc: { 'tokensUsed.openAiWhisper': trackingUnits } },
      { new: true, select: 'tokensUsed' }
    );

    console.log(`💾 MongoDB update result:`, result ? 'SUCCESS' : 'FAILED');
    
    if (result) {
      const cost = getWhisperCost(audioSeconds);
      console.log(`🎤 Whisper usage tracked:`);
      console.log(`   📏 Actual duration: ${audioSeconds.toFixed(1)} seconds (${audioMinutes.toFixed(3)} minutes)`);
      console.log(`   📊 Tracking units: ${trackingUnits} (1000 units = 1 minute)`);
      console.log(`   💰 Cost: $${cost}`);
      console.log(`💰 Total units tracked: ${result.tokensUsed.openAiWhisper}`);
      console.log(`💰 Full tokensUsed object:`, result.tokensUsed);
    } else {
      console.error('❌ User not found or update failed for userId:', userId);
    }
  } catch (error) {
    console.error('❌ Error tracking Whisper usage:', error);
    console.error('❌ Error stack:', error.stack);
  }
};

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  // Try to get token from Authorization header first, then from cookies
  let token = null;
  
  // Check Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7); // Remove 'Bearer ' prefix
    console.log('🔐 Using Authorization header token');
  } else if (req.cookies.authToken) {
    // Fallback to cookie-based authentication
    token = req.cookies.authToken;
    console.log('🍪 Using cookie-based token');
  }

  if (!token) {
    console.log('❌ No token found in Authorization header or cookies');
    return res.status(401).json({ error: "Access denied. No token provided." })
  }

  try {
    const decoded = jwt.verify(token, process.env.JSON_WEB_TOKEN_SECRET)
    req.user = decoded
    console.log('✅ Token verified for user:', decoded.userId);
    next()
  } catch (error) {
    console.log('❌ Token verification failed:', error.message);
    res.status(403).json({ error: "Invalid token." })
  }
}

// Admin middleware to check if user is admin
const authenticateAdmin = async (req, res, next) => {
  try {
    console.log('🔒 Admin middleware called for:', req.path);
    const token = req.cookies.authToken

    if (!token) {
      console.log('❌ No auth token provided');
      return res.status(401).json({ error: "Access denied. No token provided." })
    }

    console.log('🎫 Token found, verifying...');
    const decoded = jwt.verify(token, process.env.JSON_WEB_TOKEN_SECRET)
    console.log('✅ Token decoded for user:', decoded.userId);
    
    const user = await User.findById(decoded.userId)
    
    if (!user) {
      console.log('❌ User not found for ID:', decoded.userId);
      return res.status(404).json({ error: "User not found." })
    }

    console.log('👤 User found:', user.email);
    
    // Get admin emails from environment variable and convert to array
    const adminEmails = process.env.ADMIN_USER_EMAIL ? 
      process.env.ADMIN_USER_EMAIL.split(',').map(email => email.trim()) : 
      [];
      
    console.log('🔑 Admin emails from env:', adminEmails);
    console.log('🔍 Is admin?', adminEmails.includes(user.email));

    // Check if user is admin based on ADMIN_USER_EMAILS environment variable
    if (!adminEmails.includes(user.email)) {
      console.log('❌ User is not admin:', user.email);
      return res.status(403).json({ error: "Access denied. Admin privileges required." })
    }

    console.log('✅ Admin access granted for:', user.email);
    req.user = decoded
    req.adminUser = user
    next()
  } catch (error) {
    console.error('❌ Admin middleware error:', error);
    res.status(403).json({ error: "Invalid token." })
  }
}

// ===== ADMIN ROUTES (MUST BE BEFORE CATCH-ALL ROUTE) =====
app.get("/api/admin/users", authenticateAdmin, async (req, res) => {
  try {
    console.log(`👑 Admin ${req.adminUser.email} fetching all users`);
    
    // Get all users but exclude sensitive information
    const users = await User.find({})
      .select("-password -verificationCode -keys")
      .sort({ createdAt: -1 })
    
    console.log(`✅ Found ${users.length} users`);
    res.json(users)
  } catch (error) {
    console.error("Get all users error:", error)
    res.status(500).json({ error: "Failed to get users" })
  }
})

app.post("/api/admin/test-email", authenticateAdmin, async (req, res) => {
  try {
    console.log(`👑 Admin ${req.adminUser.email} requesting test email`);
    
    const testCode = generateVerificationCode();
    const emailSent = await sendVerificationEmail(req.adminUser.email, testCode, "test");
    
    if (!emailSent) {
      return res.status(500).json({ error: "Failed to send test email" });
    }
    
    console.log(`✅ Test email sent successfully to ${req.adminUser.email}`);
    res.json({ 
      message: "Test email sent successfully",
      email: req.adminUser.email
    });
  } catch (error) {
    console.error("Test email error:", error);
    res.status(500).json({ error: "Failed to send test email" });
  }
});

app.post("/api/admin/users/:id/wipe-data", authenticateAdmin, async (req, res) => {
  try {
    const userId = req.params.id
    
    console.log(`👑 Admin ${req.adminUser.email} attempting to wipe data for user: ${userId}`);
    
    // Prevent admin from wiping their own data
    if (userId === req.user.userId) {
      return res.status(400).json({ error: "Cannot wipe your own account data" })
    }
    
    // Find the user
    const user = await User.findById(userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }
    
    const userEmail = user.email
    const userName = user.name
    
    // Reset user data to initial state (keep verified and verificationCode)
    const resetData = {
      avatar: "",
      phone: "",
      id: "",
      firstName: user.name, // Keep the original name as firstName
      lastName: "",
      address: {
        street: "",
        city: "",
        state: "",
        postalCode: "",
        country: "",
      },
      completedTasks: 0,
      keys: {
        anthropic_api_key: "",
        openai_api_key: ""
      },
      brainStateAnalysis: [], // Clear all brain dumps and tasks
      settings: {
        display_name: user.name, // Keep the original name as display name
        timezone: "America/New_York",
        notification_preferences: {
          email_reminders: true,
          daily_check_in: true,
          celebration_notifications: true,
        },
        accessibility_settings: {
          high_contrast: false,
          large_text: false,
          reduce_animations: false,
        },
        ai_preferences: {
          task_generation_style: "gentle",
          default_task_duration: 15,
          celebration_level: "moderate",
        },
        theme_preferences: {
          color_scheme: "blue",
          dark_mode: false,
        },
      },
    }
    
    // Update the user with reset data (preserving name, email, password, verified, verificationCode)
    await User.findByIdAndUpdate(userId, resetData)
    
    console.log(`🧹 Admin ${req.adminUser.email} wiped data for user: ${userEmail} (${userId})`);
    res.json({ message: "User data wiped successfully" })
  } catch (error) {
    console.error("Wipe user data error:", error)
    res.status(500).json({ error: "Failed to wipe user data" })
  }
})

app.delete("/api/admin/users/:id", authenticateAdmin, async (req, res) => {
  try {
    const userId = req.params.id
    
    console.log(`👑 Admin ${req.adminUser.email} attempting to delete user: ${userId}`);
    
    // Prevent admin from deleting themselves
    if (userId === req.user.userId) {
      return res.status(400).json({ error: "Cannot delete your own account" })
    }
    
    // Find and delete the user
    const user = await User.findById(userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }
    
    const userEmail = user.email
    await User.findByIdAndDelete(userId)
    
    console.log(`🗑️ Admin ${req.adminUser.email} deleted user: ${userEmail} (${userId})`);
    res.json({ message: "User deleted successfully" })
  } catch (error) {
    console.error("Delete user error:", error)
    res.status(500).json({ error: "Failed to delete user" })
  }
})

app.post("/api/admin/users/:id/toggle-verification", authenticateAdmin, async (req, res) => {
  try {
    const userId = req.params.id
    
    console.log(`👑 Admin ${req.adminUser.email} attempting to toggle verification for user: ${userId}`);
    
    // Prevent admin from toggling their own verification
    if (userId === req.user.userId) {
      return res.status(400).json({ error: "Cannot toggle your own verification status" })
    }
    
    // Find the user
    const user = await User.findById(userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }
    
    const userEmail = user.email
    const userName = user.name
    const currentStatus = user.verified
    
    // Toggle verification status
    user.verified = !user.verified
    
    // If setting to unverified, generate a new verification code
    if (!user.verified) {
      user.verificationCode = generateVerificationCode()
    } else {
      // If verifying, clear the verification code
      user.verificationCode = ""
    }
    
    await user.save()
    
    console.log(`🔄 Admin ${req.adminUser.email} toggled verification for user: ${userEmail} (${userId}) from ${currentStatus} to ${user.verified}`);
    
    res.json({ 
      message: `User verification status updated successfully`,
      verified: user.verified,
      userEmail,
      userName
    })
  } catch (error) {
    console.error("Toggle verification error:", error)
    res.status(500).json({ error: "Failed to toggle verification status" })
  }
})

// ===== BRAINPAL PROMPT MANAGEMENT ROUTES (ADMIN ONLY) =====

// Get all BrainPal prompts
app.get("/api/admin/prompts", authenticateAdmin, async (req, res) => {
  try {
    console.log(`👑 Admin ${req.adminUser.email} fetching BrainPal prompts`);
    
    const prompts = await BrainPalPrompt.find({})
      .sort({ name: 1 })
    
    console.log(`✅ Found ${prompts.length} prompts`);
    res.json(prompts)
  } catch (error) {
    console.error("Get prompts error:", error)
    res.status(500).json({ error: "Failed to get prompts" })
  }
})

// Update a BrainPal prompt
app.put("/api/admin/prompts/:name", authenticateAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const { content, description } = req.body;
    
    console.log(`👑 Admin ${req.adminUser.email} updating prompt: ${name}`);
    
    if (!content || content.trim() === '') {
      return res.status(400).json({ error: "Content is required" });
    }
    
    const prompt = await BrainPalPrompt.findOneAndUpdate(
      { name },
      { 
        content: content.trim(),
        description: description || '',
        lastModifiedBy: req.adminUser.email,
        updatedAt: new Date()
      },
      { new: true }
    );
    
    if (!prompt) {
      return res.status(404).json({ error: "Prompt not found" });
    }
    
    console.log(`✅ Prompt ${name} updated successfully`);
    res.json({ 
      message: "Prompt updated successfully",
      prompt
    });
  } catch (error) {
    console.error("Update prompt error:", error)
    res.status(500).json({ error: "Failed to update prompt" })
  }
})

// Get a specific prompt by name
app.get("/api/admin/prompts/:name", authenticateAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    
    const prompt = await BrainPalPrompt.findOne({ name });
    
    if (!prompt) {
      return res.status(404).json({ error: "Prompt not found" });
    }
    
    res.json(prompt);
  } catch (error) {
    console.error("Get prompt error:", error)
    res.status(500).json({ error: "Failed to get prompt" })
  }
})

// Admin General Usage Statistics
app.get("/api/admin/usage-stats", authenticateAdmin, async (req, res) => {
  try {
    console.log(`👑 Admin ${req.adminUser.email} fetching usage statistics`);
    
    // Get API request statistics
    const openaiRequests = await ApiRequest.countDocuments({ provider: 'openai' });
    const anthropicRequests = await ApiRequest.countDocuments({ provider: 'anthropic' });
    
    // Get subscription statistics
    const basicSubscriptions = await Transaction.countDocuments({ 
      type: { $in: ['subscription', 'renewal'] }, 
      plan: 'basic' 
    });
    const premiumSubscriptions = await Transaction.countDocuments({ 
      type: { $in: ['subscription', 'renewal'] }, 
      plan: 'premium' 
    });
    
    // Calculate subscription revenue
    const basicRevenue = await Transaction.aggregate([
      { $match: { type: { $in: ['subscription', 'renewal'] }, plan: 'basic' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const premiumRevenue = await Transaction.aggregate([
      { $match: { type: { $in: ['subscription', 'renewal'] }, plan: 'premium' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    // Get credit purchase statistics
    const creditPurchases = await Transaction.countDocuments({ type: 'purchase' });
    const creditRevenue = await Transaction.aggregate([
      { $match: { type: 'purchase' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    // Get total credits purchased
    const totalCreditsPurchased = await Transaction.aggregate([
      { $match: { type: 'purchase' } },
      { $group: { _id: null, total: { $sum: '$creditsAdded' } } }
    ]);
    
    // Get API cost estimates
    const openaiCosts = await ApiRequest.aggregate([
      { $match: { provider: 'openai', status: 'success' } },
      { $group: { _id: null, total: { $sum: '$cost' } } }
    ]);
    const anthropicCosts = await ApiRequest.aggregate([
      { $match: { provider: 'anthropic', status: 'success' } },
      { $group: { _id: null, total: { $sum: '$cost' } } }
    ]);
    
    const stats = {
      apiRequests: {
        openai: {
          count: openaiRequests,
          estimatedCost: openaiCosts[0]?.total || 0
        },
        anthropic: {
          count: anthropicRequests,
          estimatedCost: anthropicCosts[0]?.total || 0
        }
      },
      subscriptions: {
        basic: {
          count: basicSubscriptions,
          revenue: basicRevenue[0]?.total || 0
        },
        premium: {
          count: premiumSubscriptions,
          revenue: premiumRevenue[0]?.total || 0
        },
        totalRevenue: (basicRevenue[0]?.total || 0) + (premiumRevenue[0]?.total || 0)
      },
      creditPurchases: {
        count: creditPurchases,
        totalCredits: totalCreditsPurchased[0]?.total || 0,
        revenue: creditRevenue[0]?.total || 0
      },
      totalRevenue: {
        subscriptions: (basicRevenue[0]?.total || 0) + (premiumRevenue[0]?.total || 0),
        credits: creditRevenue[0]?.total || 0,
        overall: (basicRevenue[0]?.total || 0) + (premiumRevenue[0]?.total || 0) + (creditRevenue[0]?.total || 0)
      }
    };
    
    console.log(`✅ Usage statistics compiled successfully`);
    res.json(stats);
  } catch (error) {
    console.error("Get usage stats error:", error)
    res.status(500).json({ error: "Failed to get usage statistics" })
  }
})

// Utility Functions
const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

const sendVerificationEmail = async (email, code, type = "verification") => {
  let subject, html;
  
  if (type === "test") {
    subject = "BrainPal Email Test - Success!"
    html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #10B981;">🎉 BrainPal Email Test Successful!</h2>
        <p>Great news! Your email configuration is working correctly.</p>
        <div style="background: #F0FDF4; border: 2px solid #10B981; padding: 20px; text-align: center; font-size: 18px; margin: 20px 0; border-radius: 8px;">
          <strong>✅ Email delivery is functioning properly</strong>
        </div>
        <p><strong>Test Details:</strong></p>
        <ul style="color: #374151;">
          <li>Sent to: ${email}</li>
          <li>Test code: ${code}</li>
          <li>Timestamp: ${new Date().toISOString()}</li>
          <li>Service: Resend via brainpal.app</li>
        </ul>
        <p style="color: #6B7280; font-size: 14px;">This is an automated test email from your BrainPal admin panel.</p>
      </div>
    `
  } else {
    subject = type === "verification" ? "Verify Your BrainPal Account" : "Confirm Your Changes"
    html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3B82F6;">BrainPal ${type === "verification" ? "Account Verification" : "Confirmation"}</h2>
        <p>Your verification code is:</p>
        <div style="background: #F3F4F6; padding: 20px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 3px; margin: 20px 0;">
          ${code}
        </div>
        <p>This code will expire in 10 minutes.</p>
        <p>If you didn't request this, please ignore this email.</p>
      </div>
    `
  }

  try {
    console.log(`🔄 Attempting to send email to: ${email}`)
    console.log(`📧 Using Resend API key: ${process.env.RESEND_API_KEY ? 'Present' : 'Missing'}`)
    
    const result = await resend.emails.send({
      from: "noreply@brainpal.app",
      to: email,
      subject,
      html,
    })
    
    console.log(`✅ Email sent successfully:`, result)
    return true
  } catch (error) {
    console.error("❌ Email sending error:", error)
    return false
  }
}

// Auth Routes
app.post("/api/auth/register", async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, phoneCode } = req.body

    // Validation - only firstName, email, and password are required
    if (!firstName || !email || !password) {
      return res.status(400).json({ error: "First name, email, and password are required" })
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" })
    }

    // Check if user exists
    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return res.status(400).json({ error: "User already exists" })
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12)

    // Generate verification code
    const verificationCode = generateVerificationCode()
    console.log(`📧 Generated verification code for ${email}: ${verificationCode}`)

    // Create user
    const user = new User({
      name: firstName, // Use firstName as the main name
      email,
      password: hashedPassword,
      verificationCode,
      firstName: firstName,
      lastName: lastName || "", // Optional field
      phone: phone || "", // Optional field
      phoneCode: phoneCode || "", // Optional field
      authMethod: 'email',
      settings: {
        display_name: firstName, // Set display_name to the provided firstName
      },
    })

    await user.save()
    console.log(`💾 User saved with verification code: ${user.verificationCode}`)

    // Send verification email
    const emailSent = await sendVerificationEmail(email, verificationCode)
    if (!emailSent) {
      return res.status(500).json({ error: "Failed to send verification email" })
    }

    console.log(`✅ Registration successful for ${email}, verification code sent`)

    res.status(201).json({
      message: "User created successfully. Please check your email for verification code.",
      userId: user._id,
    })
  } catch (error) {
    console.error("Registration error:", error)
    res.status(500).json({ error: "Server error during registration" })
  }
})

app.post("/api/auth/verify", async (req, res) => {
  try {
    const { email, code } = req.body

    console.log(`🔍 Verification attempt - Email: ${email}, Code: ${code}`)
    
    const user = await User.findOne({ email, verificationCode: code })
    if (!user) {
      console.log(`❌ No user found with email: ${email} and code: ${code}`)
      
      // Let's also check if user exists but with different code
      const userWithEmail = await User.findOne({ email })
      if (userWithEmail) {
        console.log(`📧 User exists with email ${email}, stored code: ${userWithEmail.verificationCode}`)
      } else {
        console.log(`📧 No user found with email: ${email}`)
      }
      
      return res.status(400).json({ error: "Invalid verification code" })
    }

    console.log(`✅ User found, verifying account for: ${email}`)

    user.verified = true
    user.verificationCode = ""
    await user.save()

    // Generate JWT token
    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JSON_WEB_TOKEN_SECRET, {
      expiresIn: "3d",
    })

    // Set cookie
    res.cookie("authToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days
    })

    console.log(`🎉 Account verified successfully for: ${email}`)

    res.json({
      message: "Email verified successfully",
      user: {
        id: user._id,
        name: user.name,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        verified: user.verified,
      },
    })
  } catch (error) {
    console.error("Verification error:", error)
    res.status(500).json({ error: "Server error during verification" })
  }
})

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body

    // Find user
    const user = await User.findOne({ email })
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" })
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password)
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" })
    }

    // Check if verified
    if (!user.verified) {
      return res.status(400).json({ error: "Please verify your email first" })
    }

    // Generate JWT token
    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JSON_WEB_TOKEN_SECRET, {
      expiresIn: "3d",
    })

    // Set cookie
    res.cookie("authToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days
    })

    res.json({
      message: "Login successful",
      token: token, // Include token in response for React Native
      user: {
        id: user._id,
        name: user.name,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        verified: user.verified,
      },
    })
  } catch (error) {
    console.error("Login error:", error)
    res.status(500).json({ error: "Server error during login" })
  }
})

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("authToken", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  })
  res.json({ message: "Logged out successfully" })
})

app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password -verificationCode")
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Handle migration from array to object structure
    if (Array.isArray(user.keys)) {
      console.log('🔄 Migrating keys from array to object structure for user:', user.email)
      // Remove the array and set as object
      user.keys = {
        anthropic_api_key: "",
        openai_api_key: ""
      }
      await user.save()
    }

    // Initialize keys structure if it doesn't exist
    if (!user.keys || typeof user.keys !== 'object') {
      user.keys = {
        anthropic_api_key: "",
        openai_api_key: ""
      }
      await user.save()
    }

    res.json(user)
  } catch (error) {
    console.error("Get user error:", error)
    res.status(500).json({ error: "Server error" })
  }
})

app.post("/api/auth/google", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Google token is required" });
    }

    // Verify the Google token
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture, given_name, family_name } = payload;

    console.log(`🔍 Google login attempt for: ${email}`);

    // Check if user exists
    let user = await User.findOne({ email });

    if (user) {
      // User exists, log them in
      console.log(`✅ Existing user found: ${email}`);
      
      // Update user profile with Google info if not set
      if (!user.avatar && picture) user.avatar = picture;
      
      // Handle name parsing for existing users
      if (!user.firstName) {
        if (given_name) {
          user.firstName = given_name;
        } else if (name) {
          // Split full name if given_name is not available
          const nameParts = name.trim().split(' ');
          user.firstName = nameParts[0] || '';
        }
      }
      
      if (!user.lastName) {
        if (family_name) {
          user.lastName = family_name;
        } else if (name && !given_name) {
          // Split full name if family_name is not available
          const nameParts = name.trim().split(' ');
          user.lastName = nameParts.slice(1).join(' ') || '';
        }
      }
      
      if (!user.settings.display_name) user.settings.display_name = name;
      
      // Set verified to true for Google users
      user.verified = true;
      user.verificationCode = "";
      
      await user.save();
    } else {
      // Create new user
      console.log(`👤 Creating new user for: ${email}`);
      
      // Parse name properly for new users
      let firstName = '';
      let lastName = '';
      
      if (given_name && family_name) {
        // Use provided given_name and family_name
        firstName = given_name;
        lastName = family_name;
      } else if (name) {
        // Split full name if individual parts are not available
        const nameParts = name.trim().split(' ');
        firstName = nameParts[0] || '';
        lastName = nameParts.slice(1).join(' ') || '';
      }
      
      user = new User({
        name: name || "Google User",
        email,
        password: await bcrypt.hash(Math.random().toString(36), 12), // Random password for Google users
        verified: true, // Google users are automatically verified
        verificationCode: "",
        avatar: picture || "",
        firstName: firstName,
        lastName: lastName,
        phone: "", // Empty phone for Google users
        phoneCode: "", // Empty phoneCode for Google users
        authMethod: 'google',
        settings: {
          display_name: name || "Google User",
        },
      });

      await user.save();
      console.log(`✅ New Google user created: ${email}`);
    }

    // Generate JWT token
    const jwtToken = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JSON_WEB_TOKEN_SECRET,
      { expiresIn: "3d" }
    );

    // Set cookie
    res.cookie("authToken", jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days
    });

    console.log(`🎉 Google login successful for: ${email}`);

    res.json({
      message: "Google login successful",
      user: {
        id: user._id,
        name: user.name,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        verified: user.verified,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({ error: "Google authentication failed" });
  }
});

// User Settings Routes
app.put("/api/user/settings", authenticateToken, async (req, res) => {
  try {
    console.log('🔧 User settings update request:', JSON.stringify(req.body, null, 2));
    
    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Initialize settings if it doesn't exist
    if (!user.settings) {
      user.settings = {}
    }

    // Update settings
    if (req.body.settings) {
      
      // Safely convert existing settings to object or use empty object
      const currentSettings = user.settings && typeof user.settings.toObject === 'function' 
        ? user.settings.toObject() 
        : (user.settings || {})
      
      user.settings = { ...currentSettings, ...req.body.settings }
      
    }

    // Handle API keys
    if (req.body.keys) {
      // Initialize keys if it doesn't exist
      if (!user.keys || typeof user.keys !== 'object') {
        user.keys = {
          anthropic_api_key: "",
          openai_api_key: "",
          openrouter_api_key: ""
        }
      }
      
      // Update API keys
      const allowedKeys = ["anthropic_api_key", "openai_api_key", "openrouter_api_key"];
      allowedKeys.forEach((key) => {
        if (req.body.keys[key] !== undefined) {
          user.keys[key] = req.body.keys[key] || "";
        }
      });
      
      console.log('🔑 API keys updated:', Object.keys(req.body.keys));
    }

    // Update other fields
    const allowedFields = ["name", "firstName", "lastName", "phone", "phoneCode", "address", "avatar"]
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        user[field] = req.body[field]
      }
    })
    
    // Validate the user before saving
    const validationError = user.validateSync();
    if (validationError) {
      console.error("Validation error:", validationError);
      return res.status(400).json({ 
        error: "Validation error", 
        details: validationError.errors 
      });
    }
    
    await user.save()
    console.log('✅ User saved successfully. Profile fields:', {
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      phoneCode: user.phoneCode
    });
    res.json({ message: "Settings updated successfully", user: user.toObject() })
  } catch (error) {
    console.error("Update settings error:", error)
    console.error("Error details:", {
      name: error.name,
      message: error.message,
      errors: error.errors,
      stack: error.stack
    })
    res.status(500).json({ error: "Server error updating settings" })
  }
})

// Update the OpenAI key route (legacy support)
app.put("/api/user/openai-key", authenticateToken, async (req, res) => {
  try {
    const { openAiKey } = req.body

    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Handle migration from array to object structure
    if (Array.isArray(user.keys)) {
      console.log('🔄 Migrating keys from array to object structure for user:', user.email)
      user.keys = {
        anthropic_api_key: "",
        openai_api_key: ""
      }
    }

    // Initialize keys if it doesn't exist or is not an object
    if (!user.keys || typeof user.keys !== 'object') {
      user.keys = {
        anthropic_api_key: "",
        openai_api_key: ""
      }
    }

    // Update the OpenAI key in the keys structure
    user.keys.openai_api_key = openAiKey || ""

    await user.save()

    res.json({ message: "OpenAI key updated successfully" })
  } catch (error) {
    console.error("Update OpenAI key error:", error)
    res.status(500).json({ error: "Server error updating OpenAI key" })
  }
})

// Get current user info
app.get("/api/user/me", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password')
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      verified: user.verified,
      avatar: user.avatar,
      createdAt: user.createdAt,
      settings: user.settings || {},
      reminders: user.reminders || []
    })
  } catch (error) {
    console.error("Get user info error:", error)
    res.status(500).json({ error: "Server error getting user info" })
  }
})

// Get user settings
app.get("/api/user/settings", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('settings')
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Return settings with defaults if not set
    const defaultSettings = {
      display_name: user.firstName || user.name || "",
      timezone: "America/New_York",
      notification_preferences: {
        email_reminders: true,
        motivational_notifications: true,
        celebration_notifications: true,
      },
      ui_preferences: {
        show_delete_task_popup: true,
      },
      accessibility_settings: {
        high_contrast: false,
        large_text: false,
        reduce_animations: false,
      },
      ai_preferences: {
        task_generation_style: "gentle",
        default_task_duration: 15,
        celebration_level: "moderate",
      },
      theme_preferences: {
        color_scheme: "blue",
        dark_mode: false,
      },
      api_keys: {
        anthropic_api_key: user.keys?.anthropic_api_key || "",
        openai_api_key: user.keys?.openai_api_key || "",
      },
    }

    const settings = { ...defaultSettings, ...(user.settings || {}) }
    
    // Ensure nested objects are properly merged
    if (user.settings) {
      settings.notification_preferences = { ...defaultSettings.notification_preferences, ...(user.settings.notification_preferences || {}) }
      settings.ui_preferences = { ...defaultSettings.ui_preferences, ...(user.settings.ui_preferences || {}) }
      settings.accessibility_settings = { ...defaultSettings.accessibility_settings, ...(user.settings.accessibility_settings || {}) }
      settings.ai_preferences = { ...defaultSettings.ai_preferences, ...(user.settings.ai_preferences || {}) }
      settings.theme_preferences = { ...defaultSettings.theme_preferences, ...(user.settings.theme_preferences || {}) }
    }

    res.json(settings)
  } catch (error) {
    console.error("Get user settings error:", error)
    res.status(500).json({ error: "Server error getting user settings" })
  }
})

// Update API keys route
app.put("/api/user/api-keys", authenticateToken, async (req, res) => {
  try {
    const { anthropic_api_key, openai_api_key } = req.body

    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Handle migration from array to object structure
    if (Array.isArray(user.keys)) {
      console.log('🔄 Migrating keys from array to object structure for user:', user.email)
      // Remove the array and set as object
      user.keys = undefined
      user.markModified('keys')
      await user.save()
      
      // Reload user to get fresh state
      const refreshedUser = await User.findById(req.user.userId)
      refreshedUser.keys = {
        anthropic_api_key: "",
        openai_api_key: ""
      }
      await refreshedUser.save()
      
      // Use the refreshed user for the rest of the operation
      user.keys = refreshedUser.keys
    }

    // Initialize keys if it doesn't exist or is not an object
    if (!user.keys || typeof user.keys !== 'object' || Array.isArray(user.keys)) {
      user.keys = {
        anthropic_api_key: "",
        openai_api_key: ""
      }
    }

    // Update API keys
    if (anthropic_api_key !== undefined) {
      user.keys.anthropic_api_key = anthropic_api_key
    }
    if (openai_api_key !== undefined) {
      user.keys.openai_api_key = openai_api_key
    }

    await user.save()

    res.json({ message: "API keys updated successfully" })
  } catch (error) {
    console.error("Update API keys error:", error)
    res.status(500).json({ error: "Server error updating API keys" })
  }
})

// Get user's emotional status
app.get("/api/user/emotional-status", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('emotionalStatus brainStateAnalysis')
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // If no emotional status exists or it's outdated, calculate it
    if (!user.emotionalStatus || user.emotionalStatus.total_analyses !== user.brainStateAnalysis.length) {
      console.log('📊 Recalculating emotional status for user:', user._id);
      await updateEmotionalStatus(user._id);
      
      // Fetch updated user data
      const updatedUser = await User.findById(req.user.userId).select('emotionalStatus');
      return res.json({
        emotionalStatus: updatedUser.emotionalStatus || {
          emotional_state_g: 5,
          energy_level_g: 5,
          brainclarity_g: 5,
          last_updated: new Date(),
          total_analyses: 0
        }
      });
    }

    res.json({
      emotionalStatus: user.emotionalStatus
    });
  } catch (error) {
    console.error("Get emotional status error:", error)
    res.status(500).json({ error: "Server error getting emotional status" })
  }
})

// Get user's token usage statistics
app.get("/api/user/token-usage", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('tokensUsed')
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    const tokensUsed = user.tokensUsed || {
      openAi4om: 0,
      claude3h: 0,
      gemini25: 0
    }

    // Calculate total tokens
    const totalTokens = tokensUsed.openAi4om + tokensUsed.claude3h + tokensUsed.gemini25

    res.json({
      tokensUsed,
      totalTokens,
      breakdown: {
        openAi4om: tokensUsed.openAi4om,
        claude3h: tokensUsed.claude3h,
        gemini25: tokensUsed.gemini25
      }
    })
  } catch (error) {
    console.error("Get token usage error:", error)
    res.status(500).json({ error: "Server error getting token usage" })
  }
})

// User Model Selection Routes
app.get("/api/user/selected-model", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('settings')
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    const selectedModel = user.settings?.ai_preferences?.selected_model || "openai4om"
    
    res.json({
      selectedModel
    })
  } catch (error) {
    console.error("Get selected model error:", error)
    res.status(500).json({ error: "Server error getting selected model" })
  }
})

app.put("/api/user/selected-model", authenticateToken, async (req, res) => {
  try {
    const { selectedModel } = req.body
    
    if (!selectedModel) {
      return res.status(400).json({ error: "Selected model is required" })
    }
    
    // Validate model selection
    const validModels = ['openai4om', 'claude3h', 'gemini25', 'custom_openai', 'custom_anthropic']
    if (!validModels.includes(selectedModel)) {
      return res.status(400).json({ error: "Invalid model selection" })
    }

    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Initialize settings if it doesn't exist
    if (!user.settings) {
      user.settings = {}
    }
    if (!user.settings.ai_preferences) {
      user.settings.ai_preferences = {}
    }
    
    user.settings.ai_preferences.selected_model = selectedModel
    await user.save()
    
    res.json({
      message: "Selected model updated successfully",
      selectedModel
    })
  } catch (error) {
    console.error("Update selected model error:", error)
    res.status(500).json({ error: "Server error updating selected model" })
  }
})

// User Settings Update Route
app.put("/api/user/settings", authenticateToken, async (req, res) => {
  try {
    console.log('👤 Update user settings request:', JSON.stringify(req.body, null, 2));
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const { firstName, lastName, phone, phoneCode, settings, anthropic_api_key, openai_api_key } = req.body.settings || req.body;
    
    // Update user profile fields
    if (firstName !== undefined) user.firstName = firstName;
    if (lastName !== undefined) user.lastName = lastName;
    if (phone !== undefined) user.phone = phone;
    if (phoneCode !== undefined) user.phoneCode = phoneCode;
    
    // Update API keys if provided
    if (anthropic_api_key !== undefined) user.anthropic_api_key = anthropic_api_key;
    if (openai_api_key !== undefined) user.openai_api_key = openai_api_key;
    
    // Update settings object
    if (settings) {
      user.settings = {
        ...user.settings,
        ...settings
      };
    }
    
    await user.save();
    
    console.log('✅ User settings updated successfully');
    res.json({
      message: "Settings updated successfully",
      user: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        phoneCode: user.phoneCode,
        settings: user.settings
      }
    });
  } catch (error) {
    console.error("Update user settings error:", error);
    res.status(500).json({ error: "Server error updating settings" });
  }
});

// Reminder Management Routes
// Get user reminders
app.get("/api/user/reminders", authenticateToken, async (req, res) => {
  try {
    console.log('🔔 Get reminders request for user:', req.user.userId);
    
    const user = await User.findById(req.user.userId).select('reminders');
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Return reminders array (empty array if no reminders)
    const reminders = user.reminders || [];
    console.log(`✅ Found ${reminders.length} reminders for user`);
    
    res.json({ reminders });
  } catch (error) {
    console.error("Get reminders error:", error);
    res.status(500).json({ error: "Server error fetching reminders" });
  }
});

// Create new reminder
app.post("/api/user/reminders", authenticateToken, async (req, res) => {
  try {
    console.log('🔔 Create reminder request:', JSON.stringify(req.body, null, 2));
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const { reminderName, reminderDescription, reminderCount, startTime, endTime } = req.body;
    
    // Validate reminder data
    if (!reminderName || typeof reminderCount !== 'number' || !startTime || !endTime) {
      return res.status(400).json({ error: "Invalid reminder data" });
    }

    // Disable any existing active reminders
    if (user.reminders) {
      user.reminders.forEach(existingReminder => {
        existingReminder.isActive = false;
      });
    } else {
      user.reminders = [];
    }

    // Generate unique reminder ID
    const reminderId = `reminder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Add new reminder
    user.reminders.push({
      reminderId,
      reminderName,
      reminderDescription,
      numberReminders: reminderCount,
      startingHours: startTime,
      endingHours: endTime,
      isActive: true,
      timeframe: [],
      createdAt: new Date()
    });

    await user.save();
    console.log('✅ Reminder created successfully for user:', user.email);
    
    res.json({ message: "Reminder created successfully", reminderId });
  } catch (error) {
    console.error("Create reminder error:", error);
    res.status(500).json({ error: "Server error creating reminder" });
  }
});

app.put("/api/user/reminders", authenticateToken, async (req, res) => {
  try {
    console.log('🔔 Reminder save request:', JSON.stringify(req.body, null, 2));
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const { reminder } = req.body;
    
    // Validate reminder data
    if (!reminder || typeof reminder.numberReminders !== 'number' || !reminder.startingHours || !reminder.endingHours) {
      return res.status(400).json({ error: "Invalid reminder data" });
    }

    // Disable any existing active reminders
    if (user.reminders) {
      user.reminders.forEach(existingReminder => {
        existingReminder.isActive = false;
      });
    } else {
      user.reminders = [];
    }

    // Add new reminder
    user.reminders.push({
      numberReminders: reminder.numberReminders,
      startingHours: reminder.startingHours,
      endingHours: reminder.endingHours,
      isActive: true,
      reminderId: reminder.reminderId,
      reminderName: reminder.reminderName,
      reminderDescription: reminder.reminderDescription,
      timeframe: reminder.timeframe || [],
      createdAt: new Date()
    });

    await user.save();
    console.log('✅ Reminder saved successfully for user:', user.email);
    
    res.json({ message: "Reminder saved successfully", reminder });
  } catch (error) {
    console.error("Save reminder error:", error);
    res.status(500).json({ error: "Server error saving reminder" });
  }
});

// Activate existing reminder
app.put("/api/user/reminders/activate", authenticateToken, async (req, res) => {
  try {
    console.log('🔔 Activate reminder request:', JSON.stringify(req.body, null, 2));
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const { reminderId } = req.body;
    if (!reminderId) {
      return res.status(400).json({ error: "Reminder ID is required" });
    }

    // Find the reminder to activate
    const reminderToActivate = user.reminders.find(r => r.reminderId === reminderId);
    if (!reminderToActivate) {
      return res.status(404).json({ error: "Reminder not found" });
    }

    // Disable all reminders first
    user.reminders.forEach(reminder => {
      reminder.isActive = false;
    });

    // Activate the specified reminder
    reminderToActivate.isActive = true;

    await user.save();
    console.log('✅ Reminder activated successfully for user:', user.email);
    
    res.json({ message: "Reminder activated successfully", reminderId });
  } catch (error) {
    console.error("Activate reminder error:", error);
    res.status(500).json({ error: "Server error activating reminder" });
  }
});

// Disable existing reminder
app.put("/api/user/reminders/disable", authenticateToken, async (req, res) => {
  try {
    console.log('🔕 Disable reminder request:', JSON.stringify(req.body, null, 2));
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const { reminderId } = req.body;
    
    if (!reminderId) {
      return res.status(400).json({ error: "Reminder ID is required" });
    }

    // Find and disable the specific reminder
    if (user.reminders) {
      const reminder = user.reminders.find(r => r.reminderId === reminderId);
      if (reminder) {
        reminder.isActive = false;
        await user.save();
        console.log('✅ Reminder disabled successfully:', reminderId);
        res.json({ message: "Reminder disabled successfully" });
      } else {
        res.status(404).json({ error: "Reminder not found" });
      }
    } else {
      res.status(404).json({ error: "No reminders found" });
    }
  } catch (error) {
    console.error("Disable reminder error:", error);
    res.status(500).json({ error: "Server error disabling reminder" });
  }
});

// Delete reminder completely
app.delete("/api/user/reminders/:reminderId", authenticateToken, async (req, res) => {
  try {
    console.log('🗑️ Delete reminder request:', req.params.reminderId);
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const { reminderId } = req.params;
    
    if (!reminderId) {
      return res.status(400).json({ error: "Reminder ID is required" });
    }

    // Find and remove the specific reminder
    if (user.reminders) {
      const reminderIndex = user.reminders.findIndex(r => r.reminderId === reminderId);
      if (reminderIndex !== -1) {
        user.reminders.splice(reminderIndex, 1);
        await user.save();
        console.log('✅ Reminder deleted completely:', reminderId);
        res.json({ message: "Reminder deleted successfully" });
      } else {
        res.status(404).json({ error: "Reminder not found" });
      }
    } else {
      res.status(404).json({ error: "No reminders found" });
    }
  } catch (error) {
    console.error("Delete reminder error:", error);
    res.status(500).json({ error: "Server error deleting reminder" });
  }
});

// Voice Recording and AI Analysis Routes
// Note: /api/voice/transcribe endpoint is defined later in the file with fallback handling

// Get user's selected AI model
app.get("/api/user/selected-model", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    const selectedModel = user.settings?.ai_preferences?.selected_model || "openai4om"
    res.json({ selectedModel })
  } catch (error) {
    console.error("Get selected model error:", error)
    res.status(500).json({ error: "Server error getting selected model" })
  }
})

// Get available AI models
app.get("/api/ai/models", authenticateToken, async (req, res) => {
  try {
    console.log('🤖 /api/ai/models endpoint called');
    
    const models = [
      {
        id: 'openai4om',
        name: 'OpenAI GPT-4o-mini',
        description: 'Fast and efficient OpenAI model',
        provider: 'openrouter',
        cost: 0,
        isDefault: true,
        icon: 'brain',
        color: '#16a34a'
      },
      {
        id: 'claude3h',
        name: 'Claude 3 Haiku',
        description: 'Anthropic\'s fast and capable model',
        provider: 'openrouter',
        cost: 0,
        isDefault: false,
        icon: 'zap',
        color: '#ea580c'
      },
      {
        id: 'gemini25',
        name: 'Gemini 2.5 Flash',
        description: 'Google\'s latest multimodal model',
        provider: 'openrouter',
        cost: 0,
        isDefault: false,
        icon: 'star',
        color: '#2563eb'
      }
    ];

    res.json({ 
      success: true, 
      data: { models }
    });
  } catch (error) {
    console.error("Error fetching models:", error);
    res.status(500).json({ error: "Failed to fetch models" });
  }
});

// Update user's selected AI model
app.put("/api/user/selected-model", authenticateToken, async (req, res) => {
  try {
    const { selectedModel } = req.body

    const validModels = ['openai4om', 'claude3h', 'gemini25', 'custom_openai', 'custom_anthropic'];
    if (!validModels.includes(selectedModel)) {
      return res.status(400).json({ error: "Invalid model selected" })
    }

    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Initialize settings structure if it doesn't exist
    if (!user.settings) {
      user.settings = {}
    }
    if (!user.settings.ai_preferences) {
      user.settings.ai_preferences = {}
    }

    user.settings.ai_preferences.selected_model = selectedModel
    await user.save()

    res.json({ message: "Selected model updated successfully", selectedModel })
  } catch (error) {
    console.error("Update selected model error:", error)
    res.status(500).json({ error: "Server error updating selected model" })
  }
})

// Get user's token usage and costs
app.get("/api/user/token-usage", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('tokensUsed')
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    const tokensUsed = user.tokensUsed || {
      openAi4om: 0,
      claude3h: 0,
      gemini25: 0,
      openAiWhisper: 0
    };

    // Calculate costs for each model category
    const costs = {
      openAi4om: getOpenRouterCost('openai/gpt-4o-mini', 0, 0, tokensUsed.openAi4om),
      claude3h: getOpenRouterCost('anthropic/claude-3-haiku', 0, 0, tokensUsed.claude3h),
      gemini25: getOpenRouterCost('google/gemini-2.5-flash', 0, 0, tokensUsed.gemini25),
      openAiWhisper: getWhisperCost((tokensUsed.openAiWhisper / 1000) * 60) // Convert units back to seconds for cost calc
    };

    const totalCost = Object.values(costs).reduce((sum, cost) => sum + cost, 0);

    res.json({
      tokensUsed,
      costs,
      totalCost: parseFloat(totalCost.toFixed(6)),
      breakdown: {
        openAi4om: {
          tokens: tokensUsed.openAi4om,
          cost: costs.openAi4om,
          model: 'GPT-4o-mini'
        },
        claude3h: {
          tokens: tokensUsed.claude3h,
          cost: costs.claude3h,
          model: 'Claude 3 Haiku'
        },
        gemini25: {
          tokens: tokensUsed.gemini25,
          cost: costs.gemini25,
          model: 'Gemini 2.5 Flash'
        },
        openAiWhisper: {
          units: tokensUsed.openAiWhisper,
          minutes: parseFloat((tokensUsed.openAiWhisper / 1000).toFixed(3)),
          cost: costs.openAiWhisper,
          model: 'OpenAI Whisper'
        }
      }
    })
  } catch (error) {
    console.error("Get token usage error:", error)
    res.status(500).json({ error: "Server error getting token usage" })
  }
})

// ===== API REMINDERS ENDPOINTS =====

// Get all active API reminders for user
app.get("/api/apireminders", authenticateToken, async (req, res) => {
  try {
    const reminders = await ApiReminder.find({ 
      user_id: req.user.userId,
      isActive: true 
    }).sort({ createdAt: -1 });
    
    res.json({ reminders });
  } catch (error) {
    console.error("Get API reminders error:", error);
    res.status(500).json({ error: "Server error getting reminders" });
  }
});

// Create new API reminder
app.post("/api/apireminders", authenticateToken, async (req, res) => {
  try {
    const { numberReminders, reminderName, startTime, endTime } = req.body;
    
    // Validate input
    if (!numberReminders || !reminderName || !startTime || !endTime) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    // Calculate timeframe based on numberReminders, startTime, and endTime
    const timeframe = calculateTimeframe(numberReminders, startTime, endTime);
    
    // Deactivate existing reminders for this user
    await ApiReminder.updateMany(
      { user_id: req.user.userId },
      { isActive: false }
    );
    
    // Create new reminder
    const reminder = new ApiReminder({
      user_id: req.user.userId,
      numberReminders,
      reminderName,
      startTime,
      endTime,
      timeframe,
      isActive: true
    });
    
    await reminder.save();
    console.log('✅ API reminder created:', reminder._id);
    
    res.json({ message: "Reminder created successfully", reminder });
  } catch (error) {
    console.error("Create API reminder error:", error);
    res.status(500).json({ error: "Server error creating reminder" });
  }
});

// Delete API reminder
app.delete("/api/apireminders/:id", authenticateToken, async (req, res) => {
  try {
    const reminderId = req.params.id;
    
    const reminder = await ApiReminder.findOneAndDelete({
      _id: reminderId,
      user_id: req.user.userId
    });
    
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    
    console.log('🗑️ API reminder deleted:', reminderId);
    res.json({ message: "Reminder deleted successfully" });
  } catch (error) {
    console.error("Delete API reminder error:", error);
    res.status(500).json({ error: "Server error deleting reminder" });
  }
});

// Helper function to calculate timeframe
function calculateTimeframe(numberReminders, startTime, endTime) {
  if (numberReminders <= 0) return [];
  
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

// Audio transcription endpoint with proper authentication
app.post("/api/voice/transcribe", authenticateToken, upload.single('audio'), async (req, res) => {
  try {
    console.log('🎤 /api/voice/transcribe endpoint called');
    
    if (!req.file) {
      console.log('❌ No audio file received');
      return res.status(400).json({ error: "Audio file is required" });
    }

    const audioFile = req.file;
    console.log('📁 Audio file received:', {
      originalname: audioFile.originalname,
      size: audioFile.size,
      mimetype: audioFile.mimetype
    });

    // Get the authenticated user
    const user = await User.findById(req.user.userId);
    if (!user) {
      console.log('❌ User not found');
      return res.status(404).json({ error: "User not found" });
    }
    console.log('👤 Using authenticated user:', user.email);

    // Check if OpenAI API key is available
    const openaiApiKey = process.env.OPENAI_MASTER_KEY;
    if (!openaiApiKey) {
      console.log('❌ OpenAI API key not configured');
      return res.status(500).json({ error: "OpenAI API key not configured" });
    }

    console.log('🔑 Using OpenAI API key:', openaiApiKey.substring(0, 20) + '...');

    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: openaiApiKey
    });

    // Create a temporary file for Whisper API with proper extension
    const fileExtension = audioFile.mimetype === 'audio/mp4' ? '.mp4' : 
                         audioFile.mimetype === 'audio/mpeg' ? '.mp3' : 
                         audioFile.mimetype === 'audio/wav' ? '.wav' : 
                         audioFile.mimetype === 'audio/webm' ? '.webm' : '.m4a';
    
    const tempFilePath = path.join(os.tmpdir(), `audio_${Date.now()}${fileExtension}`);
    
    console.log('📁 Creating temp file:', {
      path: tempFilePath,
      extension: fileExtension,
      mimetype: audioFile.mimetype,
      size: audioFile.size
    });
    
    fs.writeFileSync(tempFilePath, audioFile.buffer);
    
    let convertedFilePath = null;  // Declare in outer scope for cleanup
    
    try {
      let transcript;
      
      try {
        console.log('🎤 Attempting OpenAI Whisper transcription...');
        
        // Debug: Check file details
        const fileStats = fs.statSync(tempFilePath);
        console.log('📊 File stats:', {
          size: fileStats.size,
          path: tempFilePath,
          extension: fileExtension,
          mimetype: audioFile.mimetype
        });
        
        // Read file as buffer for more reliable handling
        const audioBuffer = fs.readFileSync(tempFilePath);
        console.log('📁 File buffer size:', audioBuffer.length);
        
        // Debug: Inspect audio file header
        const header = audioBuffer.slice(0, 16).toString('hex');
        console.log('🔍 Audio file header (hex):', header);
        console.log('🔍 Audio file header (ascii):', audioBuffer.slice(0, 12).toString('ascii'));
        
        // Enhanced format detection for Android/iOS recordings
        const headerBuffer = audioBuffer.slice(0, 16);
        const headerHex = headerBuffer.toString('hex');
        const headerAscii = headerBuffer.toString('ascii');
        
        // More comprehensive format detection
        const isValidWAV = headerBuffer.slice(0, 4).toString('ascii') === 'RIFF' && 
                          headerBuffer.slice(8, 12).toString('ascii') === 'WAVE';
        const isValidMP3 = headerBuffer.slice(0, 3).toString('hex') === 'fffb' || // MP3 frame header
                          headerBuffer.slice(0, 3).toString('ascii') === 'ID3';   // MP3 with ID3 tag
        const isValidM4A = headerBuffer.slice(4, 8).toString('ascii') === 'ftyp' && 
                          (headerAscii.includes('mp4') || headerAscii.includes('3gp') || headerAscii.includes('M4A'));
        const isValidWebM = headerBuffer.slice(0, 4).toString('ascii') === '1a45' || // WebM/Matroska
                           headerHex.startsWith('1a45dfa3');
        
        console.log('🔍 Enhanced format detection:', {
          isValidWAV,
          isValidMP3, 
          isValidM4A,
          isValidWebM,
          headerHex: headerHex.substring(0, 32),
          headerAscii: headerAscii.substring(0, 16),
          originalMimetype: audioFile.mimetype,
          detectedExtension: fileExtension
        });
        
        // Use FormData approach with buffer instead of stream
        const FormData = require('form-data');
        const formData = new FormData();
        
        // Convert audio to WAV format for better OpenAI compatibility
        let finalBuffer = audioBuffer;
        let finalFilename, finalContentType;
        
        // Function to convert audio to WAV using ffmpeg
        const convertToWAV = (inputPath, outputPath) => {
          return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
              .toFormat('wav')
              .audioChannels(1)  // Mono
              .audioFrequency(16000)  // 16kHz sample rate
              .on('end', () => {
                console.log('🔄 Audio conversion to WAV completed');
                resolve();
              })
              .on('error', (err) => {
                console.error('❌ Audio conversion failed:', err.message);
                reject(err);
              })
              .save(outputPath);
          });
        };
        
        if (isValidWAV) {
          console.log('✅ Already WAV format, using directly');
          finalFilename = 'recording.wav';
          finalContentType = 'audio/wav';
        } else if (isValidM4A || isValidMP3 || isValidWebM) {
          // Convert to WAV for better compatibility
          console.log('🔄 Converting audio to WAV format for better OpenAI compatibility...');
          convertedFilePath = path.join(os.tmpdir(), `converted_${Date.now()}.wav`);
          
          try {
            await convertToWAV(tempFilePath, convertedFilePath);
            
            // Read the converted WAV file
            finalBuffer = fs.readFileSync(convertedFilePath);
            finalFilename = 'recording.wav';
            finalContentType = 'audio/wav';
            
            console.log('✅ Audio converted to WAV successfully:', {
              originalSize: audioBuffer.length,
              convertedSize: finalBuffer.length,
              format: 'WAV'
            });
          } catch (conversionError) {
            console.log('⚠️ Audio conversion failed, using original format:', conversionError.message);
            // Fallback to original format
            if (isValidM4A) {
              finalFilename = 'recording.m4a';
              finalContentType = 'audio/m4a';
            } else if (isValidMP3) {
              finalFilename = 'recording.mp3';
              finalContentType = 'audio/mp3';
            } else {
              finalFilename = 'recording.webm';
              finalContentType = 'audio/webm';
            }
          }
        } else {
          // Default to M4A for mobile recordings
          console.log('⚠️ Format unclear, defaulting to M4A...');
          finalFilename = 'recording.m4a';
          finalContentType = 'audio/m4a';
        }
        
        // Append buffer with proper metadata
        formData.append('file', finalBuffer, {
          filename: finalFilename,
          contentType: finalContentType,
          knownLength: finalBuffer.length
        });
        formData.append('model', 'whisper-1');
        formData.append('response_format', 'text');
        formData.append('language', 'en');  // Explicitly set language
        
        console.log('📁 FormData prepared with:', {
          filename: finalFilename,
          contentType: finalContentType,
          bufferSize: finalBuffer.length,
          model: 'whisper-1',
          formatDetection: {
            isValidWAV: isValidWAV,
            isValidMP3: isValidMP3,
            originalMimetype: audioFile.mimetype
          }
        });
        
        // Make direct HTTP request to OpenAI API
        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openaiApiKey}`,
            ...formData.getHeaders()
          },
          body: formData
        });
        
        console.log('📡 OpenAI response status:', response.status);
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ OpenAI error response:', errorText);
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const transcriptionResponse = await response.text();
        
        transcript = transcriptionResponse.trim();
        console.log('✅ Whisper transcription successful:', transcript.substring(0, 100) + (transcript.length > 100 ? '...' : ''));
        
        // Calculate actual duration for tracking
        const estimatedDuration = Math.max(1, Math.floor(audioFile.size / 16000));
        
        // Track the usage
        try {
          await trackWhisperUsage(user._id, estimatedDuration);
        } catch (trackingError) {
          console.log('⚠️ Tracking error (non-critical):', trackingError.message);
        }
        
      } catch (whisperError) {
        console.error('❌ OpenAI Whisper transcription failed:', whisperError.message);
        console.error('🔍 Full error details:', {
          status: whisperError.status,
          code: whisperError.code,
          type: whisperError.type,
          error: whisperError.error,
          stack: whisperError.stack?.substring(0, 500)
        });
        
        // Fallback to helpful message if Whisper fails
        const estimatedDuration = Math.max(1, Math.floor(audioFile.size / 16000));
        const durationText = estimatedDuration > 60 ? 
          `${Math.floor(estimatedDuration / 60)}m ${estimatedDuration % 60}s` : 
          `${estimatedDuration}s`;
        
        transcript = `[🎤 Voice recording received (${Math.round(audioFile.size/1024)}KB, ~${durationText})]

🔊 Your voice was successfully recorded and saved!

⚠️ Automatic transcription failed: ${whisperError.message}

📝 Please type your thoughts below, and we'll work on improving voice transcription.

💡 Tip: You can still use the "Help me understand" button with your typed text for full brain state analysis.`;
        
        console.log('📝 Using fallback message due to error');
        
        // Still track the audio upload for analytics
        try {
          await trackWhisperUsage(user._id, estimatedDuration);
        } catch (trackingError) {
          console.log('⚠️ Tracking error (non-critical):', trackingError.message);
        }
      }

      res.json({ 
        success: true, 
        data: { transcript }
      });
      
    } finally {
      // Clean up temporary files
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      
      // Clean up converted file if it exists
      if (convertedFilePath && fs.existsSync(convertedFilePath)) {
        fs.unlinkSync(convertedFilePath);
        console.log('🧹 Cleaned up converted audio file');
      }
    }

  } catch (error) {
    console.error("Audio transcription error:", error);
    res.status(500).json({ error: "Failed to transcribe audio: " + error.message });
  }
});

app.post("/api/ai/analyze-brain-state", authenticateToken, async (req, res) => {
  try {
    console.log('🧠 /api/ai/analyze-brain-state endpoint called');
    console.log('📝 Request body:', { transcript: req.body?.transcript?.substring(0, 100) + '...', ...req.body });
    
    const { transcript, selectedModel } = req.body

    if (!transcript) {
      console.log('❌ No transcript provided');
      return res.status(400).json({ error: "Transcript is required" })
    }

    console.log('👤 Finding user:', req.user.userId);
    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Map new model names to OpenRouter models
    const modelMapping = {
      'openai4om': 'openai/gpt-4o-mini',
      'claude3h': 'anthropic/claude-3-haiku',
      'gemini25': 'google/gemini-2.5-flash',
      'custom_openai': 'openai/gpt-4o-mini',
      'custom_anthropic': 'anthropic/claude-3-haiku'
    };

    // Get the selected model from request or user preferences
    const modelToUse = selectedModel || user.settings?.ai_preferences?.selected_model || "openai4om";
    console.log('🤖 Using model:', modelToUse);

    const openRouterModel = modelMapping[modelToUse];
    if (!openRouterModel) {
      return res.status(400).json({ error: "Invalid model selection" });
    }

    // Determine if user has custom API key and should use it
    let userApiKey = null;
    if (modelToUse === 'custom_openai' && user.keys?.openai_api_key) {
      userApiKey = user.keys.openai_api_key;
    } else if (modelToUse === 'custom_anthropic' && user.keys?.anthropic_api_key) {
      userApiKey = user.keys.anthropic_api_key;
    }

    // Get model-specific prompts from database
    console.log('📋 Fetching model-specific BrainPal prompts from database...');
    const modelSuffix = modelToUse.startsWith('custom_') ? modelToUse.replace('custom_', '') : modelToUse;
    const identityPromptName = `brainpal_identity_${modelSuffix}`;
    const taskPromptName = `brainpal_task_${modelSuffix}`;
    
    const identityPrompt = await BrainPalPrompt.findOne({ name: identityPromptName, isActive: true });
    const taskPrompt = await BrainPalPrompt.findOne({ name: taskPromptName, isActive: true });
    
    if (!identityPrompt || !taskPrompt) {
      console.error(`❌ Required BrainPal prompts not found: ${identityPromptName}, ${taskPromptName}`);
      return res.status(500).json({ error: "BrainPal configuration error - model-specific prompts not found" });
    }
    
    console.log(`✅ Model-specific BrainPal prompts loaded: ${identityPromptName}, ${taskPromptName}`);
    
    const analysisPrompt = `
      ${identityPrompt.content}

      A user has just completed a 'brain dump'. Here is their raw, unfiltered transcript:
      """
      ${transcript}
      """

      Your task is to provide deeply empathetic, personalized reflection. Focus on emotional validation rather than problem-solving.

1. **Empathetic Reflection (empathetic_response):**
   - Begin with genuine warmth and acknowledgment
   - Mirror back the specific emotions and experiences they've shared
   - Use their own language and references when possible
   - Validate the complexity of their feelings
   - Keep response concise but deeply personal (2-3 sentences)

2. **Intuitive State Assessment:**
   - **Emotional State** (1-10): How emotionally regulated vs. distressed they seem
   - **Energy Level** (1-10): Their apparent vitality and motivation
   - **Brain Clarity** (1-10): How clear vs. scattered their thinking appears
   - **Reasoning:** Explain your assessment with specific references to their words

3. **Analysis Title Generation:**
   - Create a short, descriptive title (3-6 words) that summarizes the main theme or concern from their transcript
   - The title should be clear and help identify this specific analysis in task lists
   - Examples: "Work Stress Management", "Family Planning Discussion", "Career Change Anxiety", "Health Concerns Check-in"
   - Keep it concise and meaningful for easy identification

Respond with JSON: empathetic_response, emotional_state, energy_level, brain_clarity, reasoning, analysis_title.
    `;

    let analysis, tokensUsed = 0, estimatedCost = 0;
    const startTime = Date.now();
    
    try {
      console.log(`🤖 Calling OpenRouter API with model: ${openRouterModel}`);
      
      const messages = [{ role: "user", content: analysisPrompt }];
      const apiResponse = await callOpenRouterAPI(openRouterModel, messages, userApiKey);
      
      tokensUsed = apiResponse.tokensUsed;
      estimatedCost = getOpenRouterCost(openRouterModel, apiResponse.inputTokens, apiResponse.outputTokens, tokensUsed);
      
      // Parse the response
      try {
        analysis = JSON.parse(apiResponse.content);
      } catch (parseError) {
        console.log('❌ Direct JSON parse failed:', parseError.message);
        // If direct parsing fails, try to extract and clean JSON from the response
        const jsonMatch = apiResponse.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            // Clean the JSON string by removing control characters
            const cleanedJson = jsonMatch[0].replace(/[\x00-\x1F\x7F]/g, '');
            console.log('🧹 Cleaned JSON (first 200 chars):', cleanedJson.substring(0, 200) + '...');
            analysis = JSON.parse(cleanedJson);
          } catch (cleanError) {
            console.error('❌ Failed to parse cleaned JSON:', cleanError.message);
            console.error('❌ Raw AI response (first 500 chars):', apiResponse.content.substring(0, 500));
            throw new Error('Could not parse JSON from AI response: ' + cleanError.message);
          }
        } else {
          console.error('❌ No JSON found in AI response:', apiResponse.content.substring(0, 500));
          throw new Error('Could not find JSON in AI response');
        }
      }
      
      const responseTime = Date.now() - startTime;
      
      // Track token usage in user's tokensUsed array
      await trackTokenUsage(user._id, openRouterModel, tokensUsed);
      
      // Track successful API request
      await trackApiRequest(
        'openrouter',
        '/chat/completions',
        user._id,
        user.email,
        'brain-analysis',
        'success',
        {
          model: openRouterModel,
          tokensUsed,
          cost: estimatedCost,
          responseTime,
          selectedModel: modelToUse,
          userApiKey: !!userApiKey
        }
      );

      console.log('📥 AI response received');
      console.log('✅ Analysis parsed:', analysis);

      // Save to user's brain state analysis with empty actionPlan initially
      const newBrainState = {
        transcript,
        emotional_state: analysis.emotional_state,
        energy_level: analysis.energy_level,
        brain_clarity: analysis.brain_clarity,
        analysis: analysis.empathetic_response,
        analysisTitle: analysis.analysis_title || 'Brain Analysis', // AI-generated title with fallback
        actionPlan: [] // Initialize empty action plan
      }

      console.log('💾 Saving brain state analysis...');
      user.brainStateAnalysis.push(newBrainState)
      await user.save()

      // Update global emotional status based on all analyses
      console.log('📊 Updating global emotional status...');
      await updateEmotionalStatus(user._id);

      // Return the analysis with the brain state ID for reference
      const savedBrainState = user.brainStateAnalysis[user.brainStateAnalysis.length - 1]
      
      console.log('🎉 Brain state analysis completed successfully');
      res.json({
        ...analysis,
        brainStateId: savedBrainState._id,
        tokensUsed,
        estimatedCost,
        model: openRouterModel
      })
      
    } catch (aiError) {
      const responseTime = Date.now() - startTime;
      
      // Track failed API request
      await trackApiRequest(
        'openrouter',
        '/chat/completions',
        user._id,
        user.email,
        'brain-analysis',
        'error',
        {
          model: openRouterModel,
          errorMessage: aiError.message,
          responseTime,
          selectedModel: modelToUse,
          userApiKey: !!userApiKey
        }
      );
      
      throw aiError; // Re-throw to be caught by outer catch
    }
  } catch (error) {
    console.error("Brain state analysis error:", error)
    res.status(500).json({ error: "Failed to analyze brain state: " + error.message })
  }
})

// Brain Session Routes
app.post("/api/brain-sessions", authenticateToken, async (req, res) => {
  try {
    console.log('📝 Received brain session creation request:', req.body);
    const { transcript, emotional_state, energy_level, brain_clarity, ai_analysis } = req.body

    const session = new BrainSession({
      user_id: req.user.userId,
      transcript,
      emotional_state,
      energy_level,
      brain_clarity,
      ai_analysis,
      created_by: req.user.email,
    })

    console.log('💾 Saving brain session to database...');
    await session.save()
    console.log('✅ Brain session saved successfully:', session._id);
    res.status(201).json(session)
  } catch (error) {
    console.error("Create brain session error:", error)
    res.status(500).json({ error: "Failed to create brain session" })
  }
})

app.get("/api/brain-sessions", authenticateToken, async (req, res) => {
  try {
    const sessions = await BrainSession.find({ user_id: req.user.userId }).sort({ createdAt: -1 }).limit(10)
    res.json(sessions)
  } catch (error) {
    console.error("Get brain sessions error:", error)
    res.status(500).json({ error: "Failed to get brain sessions" })
  }
})

app.get("/api/brain-sessions/:id", authenticateToken, async (req, res) => {
  try {
    const session = await BrainSession.findOne({
      _id: req.params.id,
      user_id: req.user.userId,
    })

    if (!session) {
      return res.status(404).json({ error: "Session not found" })
    }

    res.json(session)
  } catch (error) {
    console.error("Get brain session error:", error)
    res.status(500).json({ error: "Failed to get brain session" })
  }
})

app.put("/api/brain-sessions/:id", authenticateToken, async (req, res) => {
  try {
    const session = await BrainSession.findOneAndUpdate({ _id: req.params.id, user_id: req.user.userId }, req.body, {
      new: true,
    })

    if (!session) {
      return res.status(404).json({ error: "Session not found" })
    }

    res.json(session)
  } catch (error) {
    console.error("Update brain session error:", error)
    res.status(500).json({ error: "Failed to update brain session" })
  }
})

// Task Generation and Management
app.post("/api/ai/generate-tasks", authenticateToken, async (req, res) => {
  try {
    const { session_id, transcript, emotional_state, energy_level, brain_clarity, reminderSettings } = req.body

    console.log(`🎯 Generating tasks for brainState: ${session_id}`);
    console.log(`📝 Transcript: ${transcript?.substring(0, 100)}...`);
    console.log(`🧠 State: Emotional ${emotional_state}/10, Energy ${energy_level}/10, Clarity ${brain_clarity}/10`);
    console.log('🔔 Reminder settings received:', reminderSettings);

    if (!transcript) {
      return res.status(400).json({ error: "Transcript is required" })
    }

    if (!session_id) {
      return res.status(400).json({ error: "Brain state ID is required" })
    }

    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Find the specific brain state analysis entry
    const brainStateAnalysis = user.brainStateAnalysis.id(session_id);
    if (!brainStateAnalysis) {
      return res.status(404).json({ error: "Brain state analysis not found" })
    }

    // Map new model names to OpenRouter models (same as brain analysis)
    const modelMapping = {
      'openai4om': 'openai/gpt-4o-mini',
      'claude3h': 'anthropic/claude-3-haiku',
      'gemini25': 'google/gemini-2.5-flash',
      'custom_openai': 'openai/gpt-4o-mini',
      'custom_anthropic': 'anthropic/claude-3-haiku'
    };

    // Get the selected model from user preferences (same logic as brain analysis)
    const modelToUse = user.settings?.ai_preferences?.selected_model || "openai4om"
    console.log('🤖 Using model for task generation:', modelToUse);

    const openRouterModel = modelMapping[modelToUse];
    if (!openRouterModel) {
      return res.status(400).json({ error: "Invalid model selection" });
    }

    // Determine if user has custom API key and should use it (same logic as brain analysis)
    let userApiKey = null;
    if (modelToUse === 'custom_openai' && user.keys?.openai_api_key) {
      userApiKey = user.keys.openai_api_key;
    } else if (modelToUse === 'custom_anthropic' && user.keys?.anthropic_api_key) {
      userApiKey = user.keys.anthropic_api_key;
    } else if (user.keys?.openrouter_api_key) {
      userApiKey = user.keys.openrouter_api_key;
    }

    // Get model-specific task generation prompts from database
    console.log('📋 Fetching model-specific BrainPal prompts for task generation...');
    const modelSuffix = modelToUse.startsWith('custom_') ? modelToUse.replace('custom_', '') : modelToUse;
    const taskPromptName = `brainpal_task_${modelSuffix}`;
    
    const taskPromptDoc = await BrainPalPrompt.findOne({ name: taskPromptName, isActive: true });
    
    if (!taskPromptDoc) {
      console.error(`❌ Required BrainPal task prompt not found: ${taskPromptName}`);
      return res.status(500).json({ error: "BrainPal configuration error - model-specific task prompt not found" });
    }
    
    console.log(`✅ Model-specific BrainPal task prompt loaded: ${taskPromptName}`);
    
    const now = new Date();
    const currentTime = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    
    // Helper function to format date as YYYY-MM-DD using local time (avoids timezone issues)
    const formatLocalDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    
    const currentDate = formatLocalDate(now);
    const tomorrow = formatLocalDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    
    // Helper function to calculate future dates using local time
    const getFutureDate = (daysFromNow) => {
      const futureDate = new Date(now.getTime() + daysFromNow * 24 * 60 * 60 * 1000);
      return formatLocalDate(futureDate);
    };
    
    const taskPrompt = `
      ${taskPromptDoc.content}
      
      CURRENT CONTEXT:
      - Today's date: ${currentDate}
      - Current time: ${currentTime}
      - Tomorrow's date: ${tomorrow}
      
      DATE CALCULATION INSTRUCTIONS:
      For any phrase like "in X days" or "X days from now":
      - Calculate the target date by adding X days to today's date (${currentDate})
      - Examples: "in 3 days" = ${getFutureDate(3)}, "in 7 days" = ${getFutureDate(7)}
      - Always use YYYY-MM-DD format for due_date
      
      User's current state:
      - Emotional State: ${emotional_state || 5}/10
      - Energy Level: ${energy_level || 5}/10  
      - Brain Clarity: ${brain_clarity || 5}/10
      
      What they shared: "${transcript}"
      
      SCHEDULING INTELLIGENCE REQUIRED:
      Parse natural language time references accurately:
      - "tomorrow at 3:30pm" → due_date: "${tomorrow}", scheduled_time: "15:30"
      - "interview tomorrow at 3:30pm" → due_date: "${tomorrow}", scheduled_time: "15:30"
      - "meeting at 2 PM" (today) → due_date: "${currentDate}", scheduled_time: "14:00"
      - "call mom this evening" → due_date: "${currentDate}", scheduled_time: "19:00" (reasonable evening time)
      - "lunch at noon" → due_date: "${currentDate}", scheduled_time: "12:00"
      - "9 AM appointment" → due_date: "${currentDate}", scheduled_time: "09:00"
      - "finish report by Friday" → due_date: [calculate Friday's date], scheduled_time: null
      
      RELATIVE DATE EXAMPLES (CRITICAL - Calculate dates correctly):
      - "in 2 days" or "2 days from now" → due_date: "${getFutureDate(2)}"
      - "in 3 days" or "3 days from now" → due_date: "${getFutureDate(3)}"
      - "in 4 days" or "4 days from now" → due_date: "${getFutureDate(4)}"
      - "in 7 days" or "7 days from now" → due_date: "${getFutureDate(7)}"
      - "doctor appointment in 4 days" → due_date: "${getFutureDate(4)}"
      - "meeting in 5 days at 2:30 PM" → due_date: "${getFutureDate(5)}", scheduled_time: "14:30"
      - "dentist in 10 days at 9 AM" → due_date: "${getFutureDate(10)}", scheduled_time: "09:00"
      
      GENERAL RULE: For "in X days" phrases, always calculate: today + X days
      
      RESPOND WITH VALID JSON containing "tasks" array where each task has:
      - title (string) - Clear, action-oriented
      - description (string) - Brief context
      - priority ("low", "medium", or "high") - Based on urgency/importance
      - due_date (YYYY-MM-DD format) - When task should be completed
      - scheduled_time (HH:MM in 24-hour format) - Only when specific time mentioned or required
      - subtasks (array with title and estimated_minutes) - Break into manageable steps
    `

    console.log(`🤖 Sending request to OpenRouter API...`);
    const startTime = Date.now();
    let result;
    
    try {
      const messages = [{ role: "user", content: taskPrompt }];
      const apiResponse = await callOpenRouterAPI(openRouterModel, messages, userApiKey);
      
      const responseTime = Date.now() - startTime;
      const tokensUsed = apiResponse.tokensUsed;
      const estimatedCost = getOpenRouterCost(openRouterModel, apiResponse.inputTokens, apiResponse.outputTokens, tokensUsed);
      
      // Track token usage in user's tokensUsed array
      await trackTokenUsage(user._id, openRouterModel, tokensUsed);
      
      // Track successful API request
      await trackApiRequest(
        'openrouter',
        '/chat/completions',
        user._id,
        user.email,
        'task-generation',
        'success',
        {
          model: openRouterModel,
          tokensUsed,
          cost: estimatedCost,
          responseTime,
          userApiKey: !!userApiKey
        }
      );

      // Parse JSON response with error handling and cleaning
      try {
        result = JSON.parse(apiResponse.content);
      } catch (parseError) {
        console.log('❌ Direct JSON parse failed for task generation:', parseError.message);
        // Try to extract JSON from markdown code blocks or other formatting
        let jsonContent = apiResponse.content;
        
        // Remove markdown code blocks if present
        const codeBlockMatch = jsonContent.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
          jsonContent = codeBlockMatch[1];
          console.log('📝 Extracted JSON from code block');
        }
        
        // Try to find JSON object in the content
        const jsonMatch = jsonContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            // Clean the JSON string by removing control characters
            const cleanedJson = jsonMatch[0].replace(/[\x00-\x1F\x7F]/g, '');
            console.log('🧹 Cleaned JSON for task generation (first 200 chars):', cleanedJson.substring(0, 200) + '...');
            result = JSON.parse(cleanedJson);
          } catch (cleanError) {
            console.error('❌ Failed to parse cleaned JSON for tasks:', cleanError.message);
            console.error('❌ Raw AI response (first 500 chars):', apiResponse.content.substring(0, 500));
            throw new Error('Could not parse JSON from AI response: ' + cleanError.message);
          }
        } else {
          console.error('❌ No JSON found in AI response for tasks:', apiResponse.content.substring(0, 500));
          throw new Error('Could not find JSON in AI response');
        }
      }
      
      console.log(`✅ OpenRouter response received with ${result.tasks?.length || 0} tasks`);

      if (!result.tasks || !Array.isArray(result.tasks)) {
        throw new Error("Invalid response format from AI")
      }
      
    } catch (apiError) {
      const responseTime = Date.now() - startTime;
      
      // Track failed API request
      await trackApiRequest(
        'openrouter',
        '/chat/completions',
        user._id,
        user.email,
        'task-generation',
        'error',
        {
          model: openRouterModel,
          errorMessage: apiError.message,
          responseTime,
          userApiKey: !!userApiKey
        }
      );
      
      throw apiError; // Re-throw to be caught by outer catch
    }

    // Update the existing brain state analysis with the action plan
    // Clear any existing action plan and add the new tasks
    brainStateAnalysis.actionPlan = result.tasks.map((taskData, index) => {
      // Calculate due_date from AI response or fallback to 3 days from now
      const dueDate = taskData.due_date ? new Date(taskData.due_date) : (() => {
        const fallbackDate = new Date();
        fallbackDate.setDate(fallbackDate.getDate() + 3);
        return fallbackDate;
      })();
      
      return {
        timestamp: new Date(),
        title: taskData.title || "Untitled Task",
        description: taskData.description || "",
        priority: taskData.priority || "medium",
        status: "pending",
        position: index, // Set position based on array index
        due_date: dueDate,
        scheduled_date: dueDate, // Use the same date as due_date instead of hardcoding to today
        scheduled_time: taskData.scheduled_time || null,
        subtasks: (taskData.subtasks || []).map(st => ({
          title: st.title || "Untitled step",
          estimated_minutes: st.estimated_minutes || 10,
          completed: false
        }))
      };
    });

    // Update the brain state analysis with confirmed states
    brainStateAnalysis.emotional_state = emotional_state;
    brainStateAnalysis.energy_level = energy_level;
    brainStateAnalysis.brain_clarity = brain_clarity;

    // Save the user with the updated brain state analysis
    await user.save();

    console.log(`💾 Updated brain state analysis with ${brainStateAnalysis.actionPlan.length} tasks`);

    // Return the tasks in a format that matches what the frontend expects
    const returnTasks = brainStateAnalysis.actionPlan.map((task) => ({
      id: `${brainStateAnalysis._id}-${task._id}`,
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      due_date: task.due_date ? task.due_date.toISOString().split('T')[0] : null,
      scheduled_date: task.scheduled_date ? task.scheduled_date.toISOString().split('T')[0] : null,
      scheduled_time: task.scheduled_time || null,
      timestamp: task.timestamp ? task.timestamp.toISOString() : new Date().toISOString(),
      subtasks: task.subtasks,
      analysis_id: brainStateAnalysis._id,
      created_date: task.timestamp ? task.timestamp.toISOString() : new Date().toISOString(),
      updated_date: task.timestamp ? task.timestamp.toISOString() : new Date().toISOString()
    }));

    // Create API reminder if reminder settings provided
    if (reminderSettings && reminderSettings.count > 0) {
      console.log('🔔 Creating API reminder with settings:', reminderSettings);
      
      try {
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
      tasks: returnTasks,
      message: `Successfully generated ${returnTasks.length} tasks`
    });

  } catch (error) {
    console.error("Task generation error:", error)
    res.status(500).json({ error: "Failed to generate tasks: " + error.message })
  }
})

// Task Management Routes
app.get("/api/tasks", authenticateToken, async (req, res) => {
  try {
    const { status, session_id } = req.query;
    
    // Get user with brain state analysis data
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Extract all tasks from all brain state analyses
    let allTasks = [];
    
    user.brainStateAnalysis.forEach((analysis, analysisIndex) => {
      analysis.actionPlan.forEach((task, taskIndex) => {
        // Create a task object with proper ID structure
        const taskData = {
          id: `${analysis._id}-${task._id}`,
          title: task.title,
          description: task.description,
          priority: task.priority,
          status: task.status,
          position: task.position !== undefined ? task.position : taskIndex, // Use saved position or fallback to index
          due_date: task.due_date ? task.due_date.toISOString().split('T')[0] : null,
          scheduled_date: task.scheduled_date ? task.scheduled_date.toISOString().split('T')[0] : null,
          scheduled_time: task.scheduled_time || null,
          postponed_until: task.postponed_until ? task.postponed_until.toISOString().split('T')[0] : null,
          timestamp: task.timestamp ? task.timestamp.toISOString() : analysis.timestamp.toISOString(),
          subtasks: task.subtasks,
          session_id: session_id, // We'll need to link this properly if needed
          analysis_id: analysis._id,
          analysis_index: analysisIndex,
          task_index: taskIndex,
          created_date: task.timestamp ? task.timestamp.toISOString() : analysis.timestamp.toISOString(),
          updated_date: task.timestamp ? task.timestamp.toISOString() : analysis.timestamp.toISOString()
        };
        
        allTasks.push(taskData);
      });
    });

    // Apply filters
    if (status) {
      allTasks = allTasks.filter(task => task.status === status);
    }
    
    if (session_id) {
      // Filter by session_id if provided - this might need adjustment based on how you want to link sessions
      allTasks = allTasks.filter(task => task.session_id === session_id);
    }

    // Sort by position first, then by creation date for items with same position
    allTasks.sort((a, b) => {
      // First sort by position (ascending)
      if (a.position !== b.position) {
        return a.position - b.position;
      }
      // If positions are the same, sort by creation date (newest first)
      return new Date(b.created_date) - new Date(a.created_date);
    });

    res.json(allTasks);
  } catch (error) {
    console.error("Get tasks error:", error);
    res.status(500).json({ error: "Failed to get tasks" });
  }
});

// Update task positions for drag and drop functionality (MUST BE BEFORE parameterized routes)
app.put("/api/tasks/reorder", authenticateToken, async (req, res) => {
  try {
    const { taskUpdates } = req.body; // Array of { taskId, position }
    
    if (!Array.isArray(taskUpdates)) {
      console.error("taskUpdates is not an array:", typeof taskUpdates, taskUpdates);
      return res.status(400).json({ error: "taskUpdates must be an array" });
    }

    if (taskUpdates.length === 0) {
      return res.json({ message: "No tasks to reorder" });
    }

    // Find the user
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Update positions for each task
    let successfulUpdates = 0;
    
    for (const update of taskUpdates) {
      const { taskId, position } = update;
      
      // Parse the compound ID (format: analysisId-taskId)
      const idParts = taskId.split('-');
      
      if (idParts.length < 2) {
        console.warn(`Invalid task ID format: ${taskId} - expected format: analysisId-taskId`);
        continue;
      }
      
      const analysisId = idParts[0];
      const actionPlanTaskId = idParts.slice(1).join('-'); // In case task ID itself contains dashes
      
      if (!analysisId || !actionPlanTaskId) {
        console.warn(`Invalid task ID format: ${taskId} - analysisId: ${analysisId}, actionPlanTaskId: ${actionPlanTaskId}`);
        continue;
      }

      // Find the brain state analysis
      const analysisIndex = user.brainStateAnalysis.findIndex(
        analysis => analysis._id.toString() === analysisId
      );
      
      if (analysisIndex === -1) {
        console.warn(`Analysis not found for ID: ${analysisId}`);
        continue;
      }

      // Find the specific task in the action plan
      const taskIndex = user.brainStateAnalysis[analysisIndex].actionPlan.findIndex(
        task => task._id.toString() === actionPlanTaskId
      );
      
      if (taskIndex === -1) {
        console.warn(`Task not found for ID: ${actionPlanTaskId}`);
        continue;
      }

      // Update the position
      user.brainStateAnalysis[analysisIndex].actionPlan[taskIndex].position = position;
      successfulUpdates++;
    }

    // Save the updated user document and wait for it to complete
    await user.save();
    
    // Add a small delay to ensure database consistency
    await new Promise(resolve => setTimeout(resolve, 100));

    res.json({ 
      message: "Task positions updated successfully", 
      updatedCount: successfulUpdates,
      totalRequested: taskUpdates.length
    });
  } catch (error) {
    console.error("Update task positions error:", error);
    res.status(500).json({ error: "Failed to update task positions" });
  }
});

app.get("/api/tasks/:id", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.id;
    
    // Parse the compound ID (format: analysisId-taskId)
    const [analysisId, actionPlanTaskId] = taskId.split('-');
    
    if (!analysisId || !actionPlanTaskId) {
      return res.status(400).json({ error: "Invalid task ID format" });
    }
    
    // Find the user and the specific analysis
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Find the brain state analysis
    const analysis = user.brainStateAnalysis.id(analysisId);
    if (!analysis) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    
    // Find the specific task in the action plan
    const task = analysis.actionPlan.id(actionPlanTaskId);
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    
    // Return the task in the expected format
    const taskData = {
      id: taskId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      due_date: task.due_date ? task.due_date.toISOString().split('T')[0] : null,
      scheduled_date: task.scheduled_date ? task.scheduled_date.toISOString().split('T')[0] : null,
      scheduled_time: task.scheduled_time || null,
      postponed_until: task.postponed_until ? task.postponed_until.toISOString().split('T')[0] : null,
      subtasks: task.subtasks,
      analysis_id: analysisId,
      session_id: analysis._id, // Use analysis ID as session ID
      transcript: analysis.transcript,
      created_date: task.timestamp ? task.timestamp.toISOString() : analysis.timestamp.toISOString(),
      updated_date: task.timestamp ? task.timestamp.toISOString() : analysis.timestamp.toISOString(),
      createdAt: analysis.timestamp
    };

    console.log(`✅ Found task: ${task.title}`);
    res.json(taskData);
  } catch (error) {
    console.error("Get task error:", error);
    res.status(500).json({ error: "Failed to get task" });
  }
});

app.put("/api/tasks/:id", authenticateToken, async (req, res) => {
  try {
    const updates = req.body;
    const taskId = req.params.id;
    
    // Parse the compound ID (format: analysisId-taskId)
    const [analysisId, actionPlanTaskId] = taskId.split('-');
    
    if (!analysisId || !actionPlanTaskId) {
      return res.status(400).json({ error: "Invalid task ID format" });
    }
    
    // Find the user and the specific analysis
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Find the brain state analysis
    const analysisIndex = user.brainStateAnalysis.findIndex(
      analysis => analysis._id.toString() === analysisId
    );
    
    if (analysisIndex === -1) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    
    // Find the specific task in the action plan
    const taskIndex = user.brainStateAnalysis[analysisIndex].actionPlan.findIndex(
      task => task._id.toString() === actionPlanTaskId
    );
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: "Task not found" });
    }
    
    // Update the task
    const task = user.brainStateAnalysis[analysisIndex].actionPlan[taskIndex];
    const previousStatus = task.status;
    Object.assign(task, updates);
    
    // Track completed tasks count changes
    if (updates.status) {
      const newStatus = updates.status;
      
      // If task is being marked as completed (and wasn't completed before)
      if (newStatus === 'completed' && previousStatus !== 'completed') {
        user.completedTasks = (user.completedTasks || 0) + 1;
        console.log(`📈 Incrementing completed tasks count to: ${user.completedTasks}`);
      }
      // If task is being unmarked as completed (was completed before, now isn't)
      else if (previousStatus === 'completed' && newStatus !== 'completed') {
        user.completedTasks = Math.max((user.completedTasks || 0) - 1, 0);
        console.log(`📉 Decrementing completed tasks count to: ${user.completedTasks}`);
      }
    }
    
    // Save the updated user document
    await user.save();
    
    // Return the updated task in the expected format
    const updatedTask = {
      id: taskId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      due_date: task.due_date ? task.due_date.toISOString().split('T')[0] : null,
      scheduled_date: task.scheduled_date ? task.scheduled_date.toISOString().split('T')[0] : null,
      scheduled_time: task.scheduled_time || null,
      postponed_until: task.postponed_until ? task.postponed_until.toISOString().split('T')[0] : null,
      subtasks: task.subtasks,
      analysis_id: analysisId,
      createdAt: task.timestamp
    };

    console.log(`✅ Updated task: ${task.title}`);
    res.json(updatedTask);
  } catch (error) {
    console.error("Update task error:", error);
    res.status(500).json({ error: "Failed to update task" });
  }
});

app.delete("/api/tasks/:id", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.id;
    
    // Parse the compound ID (format: analysisId-taskId)
    const [analysisId, actionPlanTaskId] = taskId.split('-');
    
    if (!analysisId || !actionPlanTaskId) {
      return res.status(400).json({ error: "Invalid task ID format" });
    }
    
    // Find the user and the specific analysis
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Find the brain state analysis
    const analysisIndex = user.brainStateAnalysis.findIndex(
      analysis => analysis._id.toString() === analysisId
    );
    
    if (analysisIndex === -1) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    
    // Find the specific task in the action plan
    const taskIndex = user.brainStateAnalysis[analysisIndex].actionPlan.findIndex(
      task => task._id.toString() === actionPlanTaskId
    );
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: "Task not found" });
    }
    
    // Get the task details before deletion for logging and tracking
    const taskToDelete = user.brainStateAnalysis[analysisIndex].actionPlan[taskIndex];
    const taskTitle = taskToDelete.title;
    const taskStatus = taskToDelete.status;
    
    // If we're deleting a completed task, decrement the completed tasks count
    if (taskStatus === 'completed') {
      user.completedTasks = Math.max((user.completedTasks || 0) - 1, 0);
      console.log(`📉 Decrementing completed tasks count due to deletion to: ${user.completedTasks}`);
    }
    
    // Remove the task from the action plan
    user.brainStateAnalysis[analysisIndex].actionPlan.splice(taskIndex, 1);
    
    // Save the updated user document
    await user.save();

    console.log(`🗑️ Deleted task: ${taskTitle}`);
    res.json({ message: "Task deleted successfully" });
  } catch (error) {
    console.error("Delete task error:", error);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// Action Plan Management Routes
app.get("/api/action-plans", authenticateToken, async (req, res) => {
  try {
    // Get user with brain state analysis data
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Extract all action plans from all brain state analyses
    const actionPlans = [];
    
    user.brainStateAnalysis.forEach((analysis, analysisIndex) => {
      if (analysis.actionPlan && analysis.actionPlan.length > 0) {
        const actionPlan = {
          id: analysis._id,
          timestamp: analysis.timestamp,
          emotional_state: analysis.emotional_state,
          energy_level: analysis.energy_level,
          brain_clarity: analysis.brain_clarity,
          transcript: analysis.transcript,
          analysis: analysis.analysis,
          tasks: analysis.actionPlan.map((task, taskIndex) => ({
            id: `${analysis._id}-${task._id}`,
            title: task.title,
            description: task.description,
            priority: task.priority,
            status: task.status,
            position: task.position !== undefined ? task.position : taskIndex,
            due_date: task.due_date ? task.due_date.toISOString().split('T')[0] : null,
            scheduled_date: task.scheduled_date ? task.scheduled_date.toISOString().split('T')[0] : null,
            scheduled_time: task.scheduled_time || null,
            postponed_until: task.postponed_until ? task.postponed_until.toISOString().split('T')[0] : null,
            timestamp: task.timestamp ? task.timestamp.toISOString() : analysis.timestamp.toISOString(),
            subtasks: task.subtasks || [],
            analysis_id: analysis._id,
            analysis_index: analysisIndex,
            task_index: taskIndex,
            created_date: task.timestamp ? task.timestamp.toISOString() : analysis.timestamp.toISOString(),
            updated_date: task.timestamp ? task.timestamp.toISOString() : analysis.timestamp.toISOString()
          }))
        };
        actionPlans.push(actionPlan);
      }
    });

    // Sort by timestamp (newest first)
    actionPlans.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json(actionPlans);
  } catch (error) {
    console.error("Get action plans error:", error);
    res.status(500).json({ error: "Failed to get action plans" });
  }
});

app.put("/api/action-plans/:analysisId/:taskId", authenticateToken, async (req, res) => {
  try {
    const { analysisId, taskId } = req.params;
    const updates = req.body;
    
    // Find the user and the specific analysis
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Find the brain state analysis
    const analysisIndex = user.brainStateAnalysis.findIndex(
      analysis => analysis._id.toString() === analysisId
    );
    
    if (analysisIndex === -1) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    
    // Find the specific task in the action plan
    const taskIndex = user.brainStateAnalysis[analysisIndex].actionPlan.findIndex(
      task => task._id.toString() === taskId
    );
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: "Task not found" });
    }
    
    // Update the task with the provided updates
    const task = user.brainStateAnalysis[analysisIndex].actionPlan[taskIndex];
    
    // Handle date fields properly
    if (updates.due_date) {
      task.due_date = new Date(updates.due_date);
    }
    if (updates.scheduled_date) {
      task.scheduled_date = new Date(updates.scheduled_date);
    }
    if (updates.scheduled_time) {
      task.scheduled_time = updates.scheduled_time;
    }
    
    // Update other fields
    if (updates.title !== undefined) task.title = updates.title;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.priority !== undefined) task.priority = updates.priority;
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.position !== undefined) task.position = updates.position;
    
    // Check if the brain analysis is now completed after this task update
    const brainAnalysis = user.brainStateAnalysis[analysisIndex];
    const wasCompleted = brainAnalysis.completed;
    const isNowCompleted = checkBrainAnalysisCompletion(brainAnalysis);
    
    // Update the completion status if it changed
    if (wasCompleted !== isNowCompleted) {
      brainAnalysis.completed = isNowCompleted;
      console.log(`🎯 Brain analysis ${analysisId} completion status changed: ${wasCompleted} → ${isNowCompleted}`);
    }
    
    // Save the updated user document
    await user.save();
    
    console.log(`✏️ Updated action plan task: ${task.title}`);
    res.json({ message: "Task updated successfully", task });
  } catch (error) {
    console.error("Update action plan task error:", error);
    res.status(500).json({ error: "Failed to update task" });
  }
});

app.delete("/api/action-plans/:analysisId/:taskId", authenticateToken, async (req, res) => {
  try {
    const { analysisId, taskId } = req.params;
    
    // Find the user and the specific analysis
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Find the brain state analysis
    const analysisIndex = user.brainStateAnalysis.findIndex(
      analysis => analysis._id.toString() === analysisId
    );
    
    if (analysisIndex === -1) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    
    // Find the specific task in the action plan
    const taskIndex = user.brainStateAnalysis[analysisIndex].actionPlan.findIndex(
      task => task._id.toString() === taskId
    );
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: "Task not found" });
    }
    
    // Get the task details before deletion
    const taskToDelete = user.brainStateAnalysis[analysisIndex].actionPlan[taskIndex];
    const taskTitle = taskToDelete.title;
    
    // Remove the task from the action plan
    user.brainStateAnalysis[analysisIndex].actionPlan.splice(taskIndex, 1);
    
    // Check if the brain analysis completion status changed after task deletion
    const brainAnalysis = user.brainStateAnalysis[analysisIndex];
    const wasCompleted = brainAnalysis.completed;
    const isNowCompleted = checkBrainAnalysisCompletion(brainAnalysis);
    
    // Update the completion status if it changed
    if (wasCompleted !== isNowCompleted) {
      brainAnalysis.completed = isNowCompleted;
      console.log(`🎯 Brain analysis ${analysisId} completion status changed after deletion: ${wasCompleted} → ${isNowCompleted}`);
    }
    
    // Save the updated user document
    await user.save();

    console.log(`🗑️ Deleted action plan task: ${taskTitle}`);
    res.json({ message: "Task deleted successfully" });
  } catch (error) {
    console.error("Delete action plan task error:", error);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// Subtask management routes
app.put("/api/action-plans/:analysisId/:taskId/subtasks/:subtaskIndex", authenticateToken, async (req, res) => {
  try {
    const { analysisId, taskId, subtaskIndex } = req.params;
    const updates = req.body;
    
    // Find the user and the specific analysis
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Find the brain state analysis
    const analysisIndex = user.brainStateAnalysis.findIndex(
      analysis => analysis._id.toString() === analysisId
    );
    
    if (analysisIndex === -1) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    
    // Find the specific task in the action plan
    const taskIndex = user.brainStateAnalysis[analysisIndex].actionPlan.findIndex(
      task => task._id.toString() === taskId
    );
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: "Task not found" });
    }
    
    const task = user.brainStateAnalysis[analysisIndex].actionPlan[taskIndex];
    const subtaskIdx = parseInt(subtaskIndex);
    
    if (subtaskIdx < 0 || subtaskIdx >= task.subtasks.length) {
      return res.status(404).json({ error: "Subtask not found" });
    }
    
    // Update the subtask
    if (updates.title !== undefined) task.subtasks[subtaskIdx].title = updates.title;
    if (updates.completed !== undefined) task.subtasks[subtaskIdx].completed = updates.completed;
    if (updates.estimated_minutes !== undefined) task.subtasks[subtaskIdx].estimated_minutes = updates.estimated_minutes;
    
    // Save the updated user document
    await user.save();
    
    console.log(`✏️ Updated subtask: ${task.subtasks[subtaskIdx].title}`);
    res.json({ message: "Subtask updated successfully", subtask: task.subtasks[subtaskIdx] });
  } catch (error) {
    console.error("Update subtask error:", error);
    res.status(500).json({ error: "Failed to update subtask" });
  }
});

app.delete("/api/action-plans/:analysisId/:taskId/subtasks/:subtaskIndex", authenticateToken, async (req, res) => {
  try {
    const { analysisId, taskId, subtaskIndex } = req.params;
    
    // Find the user and the specific analysis
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Find the brain state analysis
    const analysisIndex = user.brainStateAnalysis.findIndex(
      analysis => analysis._id.toString() === analysisId
    );
    
    if (analysisIndex === -1) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    
    // Find the specific task in the action plan
    const taskIndex = user.brainStateAnalysis[analysisIndex].actionPlan.findIndex(
      task => task._id.toString() === taskId
    );
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: "Task not found" });
    }
    
    const task = user.brainStateAnalysis[analysisIndex].actionPlan[taskIndex];
    const subtaskIdx = parseInt(subtaskIndex);
    
    if (subtaskIdx < 0 || subtaskIdx >= task.subtasks.length) {
      return res.status(404).json({ error: "Subtask not found" });
    }
    
    // Get subtask title before deletion
    const subtaskTitle = task.subtasks[subtaskIdx].title;
    
    // Remove the subtask
    task.subtasks.splice(subtaskIdx, 1);
    
    // Save the updated user document
    await user.save();

    console.log(`🗑️ Deleted subtask: ${subtaskTitle}`);
    res.json({ message: "Subtask deleted successfully" });
  } catch (error) {
    console.error("Delete subtask error:", error);
    res.status(500).json({ error: "Failed to delete subtask" });
  }
});

app.post("/api/action-plans/:analysisId/:taskId/subtasks", authenticateToken, async (req, res) => {
  try {
    const { analysisId, taskId } = req.params;
    const subtask = req.body;
    
    // Find the user and the specific analysis
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Find the brain state analysis
    const analysisIndex = user.brainStateAnalysis.findIndex(
      analysis => analysis._id.toString() === analysisId
    );
    
    if (analysisIndex === -1) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    
    // Find the specific task in the action plan
    const taskIndex = user.brainStateAnalysis[analysisIndex].actionPlan.findIndex(
      task => task._id.toString() === taskId
    );
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: "Task not found" });
    }
    
    const task = user.brainStateAnalysis[analysisIndex].actionPlan[taskIndex];
    
    // Add the new subtask
    const newSubtask = {
      title: subtask.title || "New Subtask",
      estimated_minutes: subtask.estimated_minutes || 10,
      completed: false
    };
    
    task.subtasks.push(newSubtask);
    
    // Save the updated user document
    await user.save();
    
    console.log(`➕ Added subtask: ${newSubtask.title}`);
    res.json({ message: "Subtask added successfully", subtask: newSubtask });
  } catch (error) {
    console.error("Add subtask error:", error);
    res.status(500).json({ error: "Failed to add subtask" });
  }
});

// Delete entire brain analysis endpoint
app.delete("/api/action-plans/:analysisId", authenticateToken, async (req, res) => {
  try {
    const { analysisId } = req.params;
    
    // Find the user
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Find the brain state analysis
    const analysisIndex = user.brainStateAnalysis.findIndex(
      analysis => analysis._id.toString() === analysisId
    );
    
    if (analysisIndex === -1) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    
    // Get the analysis details before deletion for logging
    const analysisToDelete = user.brainStateAnalysis[analysisIndex];
    const tasksCount = analysisToDelete.actionPlan ? analysisToDelete.actionPlan.length : 0;
    const completedTasksCount = analysisToDelete.actionPlan ? 
      analysisToDelete.actionPlan.filter(task => task.status === 'completed').length : 0;
    
    // Decrement completed tasks count if there were completed tasks
    if (completedTasksCount > 0) {
      user.completedTasks = Math.max((user.completedTasks || 0) - completedTasksCount, 0);
      console.log(`📉 Decrementing completed tasks count by ${completedTasksCount} due to analysis deletion. New count: ${user.completedTasks}`);
    }
    
    // Remove the entire brain state analysis
    user.brainStateAnalysis.splice(analysisIndex, 1);
    
    // Save the updated user document
    await user.save();

    console.log(`🗑️ Deleted brain analysis with ${tasksCount} tasks (${completedTasksCount} completed)`);
    res.json({ message: "Brain analysis deleted successfully", tasksDeleted: tasksCount });
  } catch (error) {
    console.error("Delete brain analysis error:", error);
    res.status(500).json({ error: "Failed to delete brain analysis" });
  }
});

// Migration endpoint to add position field to existing tasks
app.post("/api/admin/migrate-task-positions", authenticateAdmin, async (req, res) => {
  try {
    console.log(`👑 Admin ${req.adminUser.email} starting task position migration`);
    
    const users = await User.find({});
    let updatedUsers = 0;
    let updatedTasks = 0;
    
    for (const user of users) {
      let userUpdated = false;
      
      for (const analysis of user.brainStateAnalysis) {
        for (let i = 0; i < analysis.actionPlan.length; i++) {
          const task = analysis.actionPlan[i];
          if (task.position === undefined || task.position === null) {
            task.position = i; // Set position based on current array index
            userUpdated = true;
            updatedTasks++;
          }
        }
      }
      
      if (userUpdated) {
        await user.save();
        updatedUsers++;
      }
    }
    
    console.log(`✅ Migration completed: Updated ${updatedTasks} tasks across ${updatedUsers} users`);
    res.json({ 
      message: "Task position migration completed successfully",
      updatedUsers,
      updatedTasks
    });
  } catch (error) {
    console.error("Task position migration error:", error);
    res.status(500).json({ error: "Failed to migrate task positions" });
  }
});

// Progress Analysis Route
app.post("/api/ai/analyze-progress", authenticateToken, async (req, res) => {
  try {
    const { accomplishmentTranscript, activeTasks } = req.body

    const user = await User.findById(req.user.userId)
    const apiKey = (user.keys && user.keys.openai_api_key) || process.env.OPENAI_MASTER_KEY

    const openaiClient = new OpenAI({ apiKey })

    const matchingPrompt = `
      You are BrainPal's task completion assistant. Analyze what the user accomplished and match it to their active tasks.

      User's accomplishment report:
      "${accomplishmentTranscript}"

      User's current active task list:
      ${JSON.stringify(activeTasks, null, 2)}

      IMPORTANT INSTRUCTIONS:
      1. Be generous in matching - if the user mentions doing something similar or related to a subtask, mark it as completed.
      2. Look for keywords, synonyms, and related activities.
      3. If they mention completing a main task, mark ALL its subtasks as completed.
      4. Be flexible with language.
      5. Only return subtask indices that are not already completed.

      Return a JSON object with completed_tasks array, unplanned_accomplishments array, and celebration_message.
    `

    const completion = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: matchingPrompt }],
      response_format: { type: "json_object" },
    })

    const result = JSON.parse(completion.choices[0].message.content)
    res.json(result)
  } catch (error) {
    console.error("Progress analysis error:", error)
    res.status(500).json({ error: "Failed to analyze progress" })
  }
})

// Email Change Routes
app.post("/api/user/request-email-change", authenticateToken, async (req, res) => {
  try {
    const { newEmail } = req.body

    // Check if email is already taken
    const existingUser = await User.findOne({ email: newEmail })
    if (existingUser) {
      return res.status(400).json({ error: "Email already in use" })
    }

    const user = await User.findById(req.user.userId)
    const verificationCode = generateVerificationCode()

    user.verificationCode = verificationCode
    await user.save()

    const emailSent = await sendVerificationEmail(newEmail, verificationCode, "change")
    if (!emailSent) {
      return res.status(500).json({ error: "Failed to send verification email" })
    }

    res.json({ message: "Verification code sent to new email address" })
  } catch (error) {
    console.error("Request email change error:", error)
    res.status(500).json({ error: "Server error" })
  }
})

app.post("/api/user/confirm-email-change", authenticateToken, async (req, res) => {
  try {
    const { newEmail, code } = req.body

    const user = await User.findById(req.user.userId)
    if (user.verificationCode !== code) {
      return res.status(400).json({ error: "Invalid verification code" })
    }

    user.email = newEmail
    user.verificationCode = ""
    await user.save()

    res.json({ message: "Email updated successfully" })
  } catch (error) {
    console.error("Confirm email change error:", error)
    res.status(500).json({ error: "Server error" })
  }
})

// Password Change Routes
app.post("/api/user/change-password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body

    const user = await User.findById(req.user.userId)

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password)
    if (!isMatch) {
      return res.status(400).json({ error: "Current password is incorrect" })
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 12)
    user.password = hashedPassword
    await user.save()

    res.json({ message: "Password updated successfully" })
  } catch (error) {
    console.error("Change password error:", error)
    res.status(500).json({ error: "Server error" })
  }
})

// Resend verification endpoint
app.post("/api/auth/resend-verification", async (req, res) => {
  try {
    const { email } = req.body

    console.log(`📨 Resend verification request for: ${email}`)

    if (!email) {
      console.log(`❌ No email provided in resend request`)
      return res.status(400).json({ error: "Email is required" })
    }

    // Find user
    const user = await User.findOne({ email })
    if (!user) {
      console.log(`❌ No user found with email: ${email}`)
      return res.status(404).json({ error: "User not found" })
    }

    // Check if user is already verified
    if (user.verified) {
      console.log(`✅ User ${email} is already verified`)
      return res.status(400).json({ error: "Account is already verified" })
    }

    // Generate new verification code
    const verificationCode = generateVerificationCode()
    user.verificationCode = verificationCode
    await user.save()

    console.log(`🔢 New verification code generated for ${email}: ${verificationCode}`)

    // Send verification email
    const emailSent = await sendVerificationEmail(email, verificationCode)
    if (!emailSent) {
      console.log(`❌ Failed to send verification email to: ${email}`)
      return res.status(500).json({ error: "Failed to send verification email" })
    }

    console.log(`📧 Verification email resent successfully to: ${email}`)

    res.json({
      message: "Verification code sent successfully",
    })
  } catch (error) {
    console.error("Resend verification error:", error)
    res.status(500).json({ error: "Server error during resend verification" })
  }
})

// Subscription Routes
app.get("/api/subscriptions", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Ensure credits and subscription objects exist for existing users
    if (!user.subscription) {
      user.subscription = {
        isActive: false,
        plan: 'free',
        startDate: null,
        endDate: null,
        autoRenew: false
      }
    }

    if (!user.credits) {
      user.credits = {
        subscription: 0,
        purchased: 0,
        history: []
      }
      await user.save()
    }

    res.json({
      subscription: user.subscription,
      credits: {
        subscription: user.credits.subscription || 0,
        purchased: user.credits.purchased || 0,
      },
    })
  } catch (error) {
    console.error("Error fetching subscription info:", error)
    res.status(500).json({ error: "Failed to fetch subscription information" })
  }
})

// Get subscription data
app.get("/api/subscriptions", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }
    
    // Initialize credits object if it doesn't exist
    if (!user.credits) {
      user.credits = {
        subscription: 0,
        purchased: 0,
        history: []
      }
      await user.save()
    }
    
    // Initialize subscription object if it doesn't exist
    if (!user.subscription) {
      user.subscription = {
        isActive: false,
        plan: null,
        startDate: null,
        endDate: null,
        autoRenew: false
      }
      await user.save()
    }
    
    res.json({
      subscription: user.subscription,
      credits: {
        subscription: user.credits.subscription,
        purchased: user.credits.purchased
      }
    })
  } catch (error) {
    console.error("Error fetching subscription data:", error)
    res.status(500).json({ error: "Failed to fetch subscription data" })
  }
})

app.post("/api/subscriptions/subscribe", authenticateToken, async (req, res) => {
  try {
    const { plan, isRenewal } = req.body
    
    if (!['basic', 'premium'].includes(plan)) {
      return res.status(400).json({ error: "Invalid subscription plan" })
    }
    
    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }
    
    // Initialize credits object if it doesn't exist
    if (!user.credits) {
      user.credits = {
        subscription: 0,
        purchased: 0,
        history: []
      }
    }
    
    // Set subscription details
    let startDate, endDate;
    
    if (isRenewal && user.subscription && user.subscription.isActive && user.subscription.endDate) {
      // For renewals, extend from current end date
      startDate = user.subscription.startDate; // Keep original start date
      endDate = new Date(user.subscription.endDate);
      endDate.setMonth(endDate.getMonth() + 1); // Add 1 month to current end date
    } else {
      // For new subscriptions, start from today
      startDate = new Date();
      endDate = new Date();
      endDate.setMonth(endDate.getMonth() + 1); // 1 month from today
    }
    
    // Update user subscription
    user.subscription = {
      isActive: true,
      plan,
      startDate,
      endDate,
      autoRenew: true
    }
    
    // Add subscription credits based on plan
    const creditsToAdd = plan === 'basic' ? 100 : 250
    user.credits.subscription = (user.credits.subscription || 0) + creditsToAdd
    
    // Add to credit history
    user.credits.history.push({
      type: 'subscription',
      amount: creditsToAdd,
      description: `Credits from ${plan} subscription`,
      timestamp: new Date()
    })
    
    await user.save()
    
    res.json({
      message: `Successfully subscribed to ${plan} plan`,
      subscription: user.subscription,
      credits: {
        subscription: user.credits.subscription,
        purchased: user.credits.purchased
      }
    })
  } catch (error) {
    console.error("Error subscribing:", error)
    res.status(500).json({ error: "Failed to process subscription" })
  }
})

app.post("/api/subscriptions/purchase-credits", authenticateToken, async (req, res) => {
  try {
    const { packageSize } = req.body
    
    const packages = {
      small: 50,
      medium: 100,
      large: 250
    }
    
    if (!packages[packageSize]) {
      return res.status(400).json({ error: "Invalid package size" })
    }
    
    const creditsToAdd = packages[packageSize]
    const user = await User.findById(req.user.userId)
    
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }
    
    // Initialize credits object if it doesn't exist
    if (!user.credits) {
      user.credits = {
        subscription: 0,
        purchased: 0,
        history: []
      }
    }
    
    // Add purchased credits
    user.credits.purchased = (user.credits.purchased || 0) + creditsToAdd
    
    // Add to credit history
    user.credits.history.push({
      type: 'purchase',
      amount: creditsToAdd,
      description: `Purchased ${packageSize} credit package`,
      timestamp: new Date()
    })
    
    await user.save()
    
    res.json({
      message: `Successfully purchased ${creditsToAdd} credits`,
      credits: {
        subscription: user.credits.subscription,
        purchased: user.credits.purchased
      }
    })
  } catch (error) {
    console.error("Error purchasing credits:", error)
    res.status(500).json({ error: "Failed to purchase credits" })
  }
})

app.get("/api/subscriptions/credit-history", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Initialize credits object if it doesn't exist
    if (!user.credits) {
      user.credits = {
        subscription: 0,
        purchased: 0,
        history: []
      }
      await user.save()
    }

    res.json({
      history: user.credits.history || []
    })
  } catch (error) {
    console.error("Error fetching credit history:", error)
    res.status(500).json({ error: "Failed to fetch credit history" })
  }
})

// PayPal payment verification endpoint
app.post("/api/paypal/verify-payment", authenticateToken, async (req, res) => {
  try {
    const { orderID, payerID, details, type, plan, packageSize } = req.body;
    
    console.log('🎯 PayPal payment verification:', { orderID, payerID, type, plan, packageSize });
    
    // Verify the payment with PayPal
    if (!orderID || !details) {
      return res.status(400).json({ error: "Missing payment details" });
    }
    
    // Check if payment was successful
    if (details.status !== 'COMPLETED') {
      return res.status(400).json({ error: "Payment not completed" });
    }
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Initialize credits object if it doesn't exist
    if (!user.credits) {
      user.credits = {
        subscription: 0,
        purchased: 0,
        history: []
      };
    }
    
    let result = {};
    const paymentAmount = parseFloat(details.purchase_units[0].amount.value);
    
    if (type === 'subscription' || type === 'renewal') {
      if (!['basic', 'premium'].includes(plan)) {
        return res.status(400).json({ error: "Invalid subscription plan" });
      }
      
      // Set subscription details
      let startDate, endDate;
      const creditsToAdd = plan === 'basic' ? 10 : 25;
      
      if (type === 'renewal' && user.subscription && user.subscription.isActive && user.subscription.endDate) {
        // For renewals, extend from current end date
        startDate = user.subscription.startDate; // Keep original start date
        endDate = new Date(user.subscription.endDate);
        endDate.setMonth(endDate.getMonth() + 1); // Add 1 month to current end date
      } else {
        // For new subscriptions, start from today
        startDate = new Date();
        endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 1); // Add 1 month from today
      }
      
      user.subscription = {
        isActive: true,
        plan: plan,
        startDate: startDate,
        endDate: endDate,
        autoRenew: false
      };
      
      // Add subscription credits
      user.credits.subscription += creditsToAdd;
      
      // Record transaction
      await recordTransaction(
        user._id,
        user.email,
        type,
        'paypal',
        paymentAmount,
        creditsToAdd,
        `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan ${type}`,
        { transactionId: orderID, paypalOrderId: orderID }
      );
      
      result = {
        subscription: user.subscription,
        creditsAdded: creditsToAdd,
        message: `Successfully ${type === 'renewal' ? 'renewed' : 'subscribed to'} ${plan} plan`
      };
      
    } else if (type === 'credits') {
      const packages = {
        small: { credits: 50, price: 4.99 },
        medium: { credits: 100, price: 8.99 },
        large: { credits: 250, price: 19.99 }
      };
      
      const selectedPackage = packages[packageSize];
      if (!selectedPackage) {
        return res.status(400).json({ error: "Invalid package size" });
      }
      
      // Add purchased credits
      user.credits.purchased += selectedPackage.credits;
      
      // Add to credit history
      user.credits.history.push({
        type: 'purchase',
        amount: selectedPackage.credits,
        description: `Purchased ${selectedPackage.credits} credits via PayPal (${packageSize} package)`,
        timestamp: new Date(),
        paymentMethod: 'paypal',
        transactionId: orderID
      });
      
      // Record transaction
      await recordTransaction(
        user._id,
        user.email,
        'purchase',
        'paypal',
        paymentAmount,
        selectedPackage.credits,
        `${selectedPackage.credits} credits purchase`,
        { 
          transactionId: orderID, 
          paypalOrderId: orderID,
          packageSize: packageSize
        }
      );
      
      result = {
        creditsAdded: selectedPackage.credits,
        totalCredits: user.credits.subscription + user.credits.purchased,
        message: `Successfully purchased ${selectedPackage.credits} credits`
      };
    }
    
    await user.save();
    
    console.log('✅ PayPal payment processed successfully:', result);
    res.json(result);
    
  } catch (error) {
    console.error('❌ PayPal payment verification error:', error);
    res.status(500).json({ error: "Failed to process PayPal payment: " + error.message });
  }
});

// Create Stripe payment intent
app.post("/api/stripe/create-payment-intent", authenticateToken, async (req, res) => {
  try {
    const { type, plan, packageSize, amount: frontendAmount } = req.body;
    
    let amount = 0;
    let description = '';
    
    console.log('💳 Stripe payment intent request:', { type, plan, packageSize, frontendAmount });
    
    if (type === 'subscription' || type === 'renewal') {
      amount = plan === 'basic' ? 999 : 1999; // Amount in cents
      description = `${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan ${type}`;
    } else if (type === 'credits') {
      // Handle credit purchases - packageSize is the number of credits
      if (frontendAmount) {
        // Use the amount sent from frontend (already in cents)
        amount = frontendAmount;
        description = `One-time purchase of ${packageSize} credits`;
      } else {
        // Fallback to credit amount calculation
        const creditPrices = {
          100: 499,   // $4.99 for 100 credits
          250: 899,   // $8.99 for 250 credits
          500: 1999   // $19.99 for 500 credits
        };
        amount = creditPrices[packageSize] || 499; // Default to 100 credits price
        description = `One-time purchase of ${packageSize} credits`;
      }
    }
    
    console.log('💳 Creating payment intent:', { amount, description, packageSize });
    
    if (amount === 0) {
      throw new Error('Invalid payment amount');
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      description,
      metadata: {
        userId: req.user.userId,
        type,
        plan: plan || '',
        packageSize: packageSize ? packageSize.toString() : '',
        creditsAmount: type === 'credits' ? packageSize.toString() : ''
      }
    });
    
    console.log('✅ Payment intent created successfully:', paymentIntent.id);

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (error) {
    console.error('❌ Stripe payment intent creation error:', error);
    res.status(500).json({ error: 'Failed to create payment intent', details: error.message });
  }
});

// Confirm Stripe payment and process transaction
app.post("/api/stripe/confirm-payment", authenticateToken, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    
    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const userId = req.user.userId;
    const { type, plan, packageSize } = paymentIntent.metadata;
    
    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Initialize credits object if it doesn't exist
    if (!user.credits) {
      user.credits = {
        subscription: 0,
        purchased: 0,
        history: []
      };
    }

    // Process the transaction (same logic as PayPal)
    if (type === 'subscription' || type === 'renewal') {
      // Handle subscription/renewal
      const creditsToAdd = plan === 'basic' ? 100 : 250;
      const amount = plan === 'basic' ? 9.99 : 19.99;
      
      user.credits.subscription = (user.credits.subscription || 0) + creditsToAdd;
      
      // Update subscription
      let startDate, endDate;
      
      if (type === 'renewal' && user.subscription && user.subscription.isActive && user.subscription.endDate) {
        // For renewals, extend from current end date
        startDate = user.subscription.startDate; // Keep original start date
        endDate = new Date(user.subscription.endDate);
        endDate.setMonth(endDate.getMonth() + 1); // Add 1 month to current end date
      } else {
        // For new subscriptions, start from today
        startDate = new Date();
        endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 1); // 1 month from today
      }
      
      // Update user subscription
      user.subscription = {
        isActive: true,
        plan,
        startDate,
        endDate,
        autoRenew: true
      };
      
      // Add to credit history
      const actionType = type === 'renewal' ? 'renewal' : 'subscription';
      user.credits.history.push({
        type: actionType,
        amount: creditsToAdd,
        description: `Credits from ${plan} ${actionType} (stripe)`,
        date: new Date(),
        paymentMethod: 'stripe'
      });

      // Record transaction
      await recordTransaction(user._id, user.email, actionType, 'stripe', amount, creditsToAdd, `Credits from ${plan} ${actionType} (stripe)`, { plan, paymentIntentId });
      
    } else if (type === 'credits') {
      // Handle credit purchase - packageSize is the number of credits
      const creditAmount = parseInt(paymentIntent.metadata.creditsAmount || packageSize);
      const amountInDollars = (paymentIntent.amount / 100).toFixed(2);
      
      console.log('💳 Confirm payment - Processing credit purchase:', { creditAmount, amountInDollars, packageSize });
      
      if (!creditAmount || creditAmount <= 0) {
        return res.status(400).json({ error: 'Invalid credit amount' });
      }
      
      user.credits.purchased = (user.credits.purchased || 0) + creditAmount;
      
      // Add to credit history
      user.credits.history.push({
        type: 'purchase',
        amount: creditAmount,
        description: `Purchased ${creditAmount} credits for $${amountInDollars} (Stripe)`,
        timestamp: new Date()
      });

      // Record transaction
      await recordTransaction(
        user._id, 
        user.email, 
        'purchase', 
        'stripe', 
        parseFloat(amountInDollars), 
        creditAmount, 
        `Purchased ${creditAmount} credits for $${amountInDollars} (Stripe)`, 
        { packageSize: creditAmount, paymentIntentId }
      );
      
      console.log('✅ Confirm payment - Credits added to user:', { userId, creditAmount, newTotal: user.credits.purchased });
    }

    await user.save();

    res.json({ 
      success: true, 
      message: 'Payment processed successfully',
      credits: {
        subscription: user.credits.subscription || 0,
        purchased: user.credits.purchased || 0
      }
    });

  } catch (error) {
    console.error('Stripe payment confirmation error:', error);
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

// Process checkout payment (legacy endpoint for Stripe)
app.post("/api/checkout/process", authenticateToken, async (req, res) => {
  try {
    const { type, plan, packageSize, paymentMethod } = req.body
    
    if (!['paypal', 'stripe'].includes(paymentMethod)) {
      return res.status(400).json({ error: "Invalid payment method" })
    }
    
    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }
    
    // Initialize credits object if it doesn't exist
    if (!user.credits) {
      user.credits = {
        subscription: 0,
        purchased: 0,
        history: []
      }
    }
    
    let result = {}
    
    if (type === 'subscription' || type === 'renewal') {
      if (!['basic', 'premium'].includes(plan)) {
        return res.status(400).json({ error: "Invalid subscription plan" })
      }
      
      // Set subscription details
      let startDate, endDate;
      
      if (type === 'renewal' && user.subscription && user.subscription.isActive && user.subscription.endDate) {
        // For renewals, extend from current end date
        startDate = user.subscription.startDate; // Keep original start date
        endDate = new Date(user.subscription.endDate);
        endDate.setMonth(endDate.getMonth() + 1); // Add 1 month to current end date
      } else {
        // For new subscriptions, start from today
        startDate = new Date();
        endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 1); // 1 month from today
      }
      
      // Update user subscription
      user.subscription = {
        isActive: true,
        plan,
        startDate,
        endDate,
        autoRenew: true
      }
      
      // Add subscription credits based on plan
      const creditsToAdd = plan === 'basic' ? 100 : 250
      const amount = plan === 'basic' ? 9.99 : 19.99 // Pricing in dollars
      user.credits.subscription = (user.credits.subscription || 0) + creditsToAdd
      
      // Add to credit history
      const actionType = type === 'renewal' ? 'renewal' : 'subscription';
      user.credits.history.push({
        type: actionType,
        amount: creditsToAdd,
        description: `Credits from ${plan} ${actionType} (${paymentMethod})`,
        timestamp: new Date()
      })
      
      // Record transaction in database
      await recordTransaction(
        user._id,
        user.email,
        actionType,
        paymentMethod,
        amount,
        creditsToAdd,
        `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan ${actionType}`,
        { plan }
      );
      
      const actionMessage = type === 'renewal' ? 'renewed' : 'subscribed to';
      result = {
        message: `Successfully ${actionMessage} ${plan} plan via ${paymentMethod}`,
        subscription: user.subscription,
        credits: {
          subscription: user.credits.subscription,
          purchased: user.credits.purchased
        }
      }
    } else if (type === 'credits') {
      const packages = {
        small: { credits: 50, price: 4.99 },
        medium: { credits: 100, price: 9.99 },
        large: { credits: 250, price: 19.99 }
      }
      
      if (!packages[packageSize]) {
        return res.status(400).json({ error: "Invalid package size" })
      }
      
      const creditsToAdd = packages[packageSize].credits
      const amount = packages[packageSize].price
      
      // Add purchased credits
      user.credits.purchased = (user.credits.purchased || 0) + creditsToAdd
      
      // Add to credit history
      user.credits.history.push({
        type: 'purchase',
        amount: creditsToAdd,
        description: `Purchased ${packageSize} credit package (${paymentMethod})`,
        timestamp: new Date()
      })
      
      // Record transaction in database
      await recordTransaction(
        user._id,
        user.email,
        'purchase',
        paymentMethod,
        amount,
        creditsToAdd,
        `${packageSize.charAt(0).toUpperCase() + packageSize.slice(1)} credit package`,
        { packageSize }
      );
      
      result = {
        message: `Successfully purchased ${creditsToAdd} credits via ${paymentMethod}`,
        credits: {
          subscription: user.credits.subscription,
          purchased: user.credits.purchased
        }
      }
    } else {
      return res.status(400).json({ error: "Invalid checkout type" })
    }
    
    await user.save()
    
    res.json(result)
  } catch (error) {
    console.error("Error processing checkout:", error)
    res.status(500).json({ error: "Failed to process payment" })
  }
})

// Serve static files from the frontend build (MUST BE AFTER ALL API ROUTES)
app.use(express.static(path.join(__dirname, "dist")));

// Get credit history
app.get("/api/subscriptions/credit-history", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }
    
    // Initialize credits object if it doesn't exist
    if (!user.credits) {
      user.credits = {
        subscription: 0,
        purchased: 0,
        history: []
      }
      await user.save()
    }
    
    res.json({
      history: user.credits.history || []
    })
  } catch (error) {
    console.error("Error fetching credit history:", error)
    res.status(500).json({ error: "Failed to fetch credit history" })
  }
})

// Stripe test endpoint
app.get("/api/stripe/test", authenticateToken, async (req, res) => {
  try {
    console.log('Testing Stripe connection...');
    
    // Test creating a simple payment intent
    const testIntent = await stripe.paymentIntents.create({
      amount: 1000, // $10.00
      currency: 'usd',
      description: 'Test connection',
      automatic_payment_methods: {
        enabled: true,
      },
    });
    
    console.log('Stripe test successful:', testIntent.id);
    
    // Cancel the test intent
    await stripe.paymentIntents.cancel(testIntent.id);
    
    res.json({
      success: true,
      message: 'Stripe connection working',
      testIntentId: testIntent.id
    });
    
  } catch (error) {
    console.error('Stripe test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      type: error.type
    });
  }
});

// Stripe payment intent endpoint
app.post("/api/stripe/create-payment-intent", authenticateToken, async (req, res) => {
  try {
    const { type, amount, currency = 'usd', description, plan, planName, packageSize } = req.body;
    
    console.log('Creating payment intent with data:', {
      type,
      amount,
      amountType: typeof amount,
      currency,
      description,
      plan,
      planName,
      packageSize
    });
    
    // Validate and ensure amount is a proper integer
    let amountInCents;
    if (typeof amount === 'string') {
      amountInCents = parseInt(amount, 10);
    } else if (typeof amount === 'number') {
      amountInCents = Math.round(amount);
    } else {
      console.error('Amount is not a string or number:', typeof amount, amount);
      return res.status(400).json({ 
        error: "Invalid amount type",
        received: amount,
        type: typeof amount
      });
    }
    
    console.log('Amount validation:', {
      original: amount,
      originalType: typeof amount,
      parsed: amountInCents,
      parsedType: typeof amountInCents,
      isValid: !isNaN(amountInCents) && amountInCents >= 50 && Number.isInteger(amountInCents)
    });
    
    if (!amountInCents || isNaN(amountInCents) || amountInCents < 50 || !Number.isInteger(amountInCents)) {
      console.error('Invalid amount:', { amount, amountInCents });
      return res.status(400).json({ 
        error: "Amount must be a valid integer of at least 50 cents",
        received: amount,
        parsed: amountInCents
      });
    }
    
    // Create payment intent with Stripe
    console.log('About to create Stripe payment intent with:', {
      amount: amountInCents,
      amountType: typeof amountInCents,
      currency: currency,
      description: description
    });
    

    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents, // Amount in cents (already validated)
      currency: currency,
      description: description,
      metadata: {
        userId: req.user.userId,
        type: type,
        plan: plan || '',
        planName: planName || '',
        packageSize: packageSize || ''
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });
    
    console.log('Payment intent created:', paymentIntent.id);
    
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
    
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: error.message || 'Failed to create payment intent' });
  }
});

// Stripe webhook endpoint for payment confirmations
app.post("/api/stripe/webhook", express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  console.log('🎯 Webhook received:', {
    hasSignature: !!sig,
    webhookSecret: webhookSecret,
    bodyType: typeof req.body,
    bodyLength: req.body ? req.body.length : 0
  });
  
  let event;
  
  try {
    if (webhookSecret && webhookSecret !== 'none') {
      console.log('🔐 Using webhook signature verification');
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      console.log('⚠️ Skipping webhook signature verification (webhook secret not configured)');
      event = JSON.parse(req.body.toString());
    }
    
    console.log('📨 Webhook event parsed:', {
      type: event.type,
      id: event.id,
      hasData: !!event.data
    });
    
  } catch (err) {
    console.error('❌ Webhook parsing failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Handle the event
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('Payment succeeded:', paymentIntent.id);
      
      try {
        // Process the successful payment
        const userId = paymentIntent.metadata.userId;
        const type = paymentIntent.metadata.type;
        const plan = paymentIntent.metadata.plan;
        const packageSize = paymentIntent.metadata.packageSize;
        
        const user = await User.findById(userId);
        if (!user) {
          console.error('User not found for payment:', userId);
          break;
        }
        
        if (type === 'subscription') {
          // Update user subscription
          user.subscription = {
            plan: plan,
            status: 'active',
            start_date: new Date(),
            next_billing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
            stripe_payment_intent_id: paymentIntent.id
          };
          
          // Add subscription credits based on plan
          const planCredits = {
            basic: 200,
            premium: 500
          };
          
          if (!user.credits) {
            user.credits = { subscription: 0, purchased: 0, history: [] };
          }
          
          user.credits.subscription = planCredits[plan] || 0;
          user.credits.history.push({
            type: 'subscription',
            amount: planCredits[plan] || 0,
            timestamp: new Date(),
            description: `${plan} plan subscription (Stripe)`
          });
          
        } else if (type === 'credits') {
          // Add purchased credits
          const creditAmount = parseInt(paymentIntent.metadata.creditsAmount || packageSize);
          const amountInDollars = (paymentIntent.amount / 100).toFixed(2);
          
          console.log('💳 Processing credit purchase:', { 
            creditAmount, 
            amountInDollars, 
            packageSize,
            metadata: paymentIntent.metadata,
            userIdFromMetadata: paymentIntent.metadata.userId,
            currentUserCredits: user.credits
          });
          
          if (!user.credits) {
            console.log('🔧 Initializing user credits object');
            user.credits = { subscription: 0, purchased: 0, history: [] };
          }
          
          const previousCredits = user.credits.purchased;
          user.credits.purchased += creditAmount;
          
          console.log('📊 Credit update:', {
            previousCredits,
            creditAmount,
            newTotal: user.credits.purchased
          });
          
          user.credits.history.push({
            type: 'purchase',
            amount: creditAmount,
            timestamp: new Date(),
            description: `Purchased ${creditAmount} credits for $${amountInDollars} (Stripe)`
          });
          
          console.log('📝 Added to credit history:', user.credits.history[user.credits.history.length - 1]);
          
          // Record transaction for admin tracking
          await recordTransaction(
            user._id, 
            user.email, 
            'purchase', 
            'stripe', 
            parseFloat(amountInDollars), 
            creditAmount, 
            `Purchased ${creditAmount} credits for $${amountInDollars} (Stripe)`, 
            { packageSize: creditAmount, paymentIntentId: paymentIntent.id }
          );
          
          console.log('✅ Credits processed successfully:', { 
            userId, 
            creditAmount, 
            previousTotal: previousCredits,
            newTotal: user.credits.purchased,
            historyEntries: user.credits.history.length
          });
        }
        
        console.log('💾 Saving user to database with updated credits...');
        const savedUser = await user.save();
        console.log('✅ User saved successfully:', {
          userId,
          finalCredits: savedUser.credits,
          subscriptionStatus: savedUser.subscription?.status || 'none'
        });
        
      } catch (error) {
        console.error('Error processing successful payment:', error);
      }
      
      break;
    
    case 'payment_intent.payment_failed':
      console.log('Payment failed:', event.data.object.id);
      break;
    
    default:
      console.log(`Unhandled event type ${event.type}`);
  }
  
  res.json({received: true});
});

// Manual webhook test endpoint for development
app.post("/api/stripe/webhook-test", authenticateToken, async (req, res) => {
  try {
    const { paymentIntentId, type, packageSize, plan, planName } = req.body;
    
    console.log('🧪 Manual webhook test triggered:', { paymentIntentId, type, packageSize, plan, planName });
    
    // Determine amount based on type
    let amount = 0;
    if (type === 'subscription') {
      amount = plan === 'basic' ? 999 : 1999; // Basic: $9.99, Premium: $19.99
    } else if (type === 'credits') {
      amount = packageSize === 100 ? 499 : packageSize === 250 ? 899 : 1999;
    }
    
    // Simulate a successful payment intent
    const mockPaymentIntent = {
      id: paymentIntentId || 'pi_test_' + Date.now(),
      amount: amount,
      metadata: {
        userId: req.user.userId,
        type: type || 'credits',
        plan: plan || '',
        packageSize: packageSize ? packageSize.toString() : '',
        creditsAmount: type === 'credits' ? (packageSize ? packageSize.toString() : '100') : ''
      }
    };
    
    // Process the mock payment
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const amountInDollars = (mockPaymentIntent.amount / 100).toFixed(2);
    
    if (type === 'subscription') {
      // Handle subscription plan update
      console.log('💳 Processing manual subscription:', { 
        plan, 
        planName,
        amountInDollars,
        currentSubscription: user.subscription
      });
      
      // Update user subscription
      user.subscription = {
        plan: plan,
        status: 'active',
        start_date: new Date(),
        next_billing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        stripe_payment_intent_id: mockPaymentIntent.id
      };
      
      // Add subscription credits based on plan
      const planCredits = {
        basic: 200,
        premium: 500
      };
      
      if (!user.credits) {
        user.credits = { subscription: 0, purchased: 0, history: [] };
      }
      
      user.credits.subscription = planCredits[plan] || 0;
      user.credits.history.push({
        type: 'subscription',
        amount: planCredits[plan] || 0,
        timestamp: new Date(),
        description: `Manual test: ${plan} plan subscription for $${amountInDollars} (Stripe)`
      });
      
      console.log('💾 Saving user to database with updated subscription...');
      const savedUser = await user.save();
      
      console.log('✅ Manual subscription webhook completed:', {
        userId: req.user.userId,
        plan: plan,
        subscriptionCredits: planCredits[plan],
        subscriptionStatus: savedUser.subscription.status
      });
      
      res.json({
        success: true,
        message: 'Subscription updated successfully',
        subscription: {
          plan: savedUser.subscription.plan,
          status: savedUser.subscription.status,
          credits: planCredits[plan]
        }
      });
      
    } else if (type === 'credits') {
      // Handle credit purchase
      const creditAmount = parseInt(mockPaymentIntent.metadata.creditsAmount || packageSize);
      
      console.log('💳 Processing manual credit purchase:', { 
        creditAmount, 
        amountInDollars, 
        packageSize,
        currentUserCredits: user.credits
      });
      
      if (!user.credits) {
        console.log('🔧 Initializing user credits object');
        user.credits = { subscription: 0, purchased: 0, history: [] };
      }
      
      const previousCredits = user.credits.purchased;
      user.credits.purchased += creditAmount;
      
      user.credits.history.push({
        type: 'purchase',
        amount: creditAmount,
        timestamp: new Date(),
        description: `Manual test: Purchased ${creditAmount} credits for $${amountInDollars} (Stripe)`
      });
      
      console.log('💾 Saving user to database with updated credits...');
      const savedUser = await user.save();
      
      console.log('✅ Manual credit webhook completed:', {
        userId: req.user.userId,
        creditAmount,
        previousTotal: previousCredits,
        newTotal: savedUser.credits.purchased,
        historyEntries: savedUser.credits.history.length
      });
      
      res.json({
        success: true,
        message: 'Credits added successfully',
        credits: {
          previous: previousCredits,
          added: creditAmount,
          total: savedUser.credits.purchased
        }
      });
    } else {
      throw new Error('Invalid payment type: ' + type);
    }
    
  } catch (error) {
    console.error('❌ Manual webhook test error:', error);
    res.status(500).json({ error: 'Failed to process manual webhook test', details: error.message });
  }
});

// Cancel subscription endpoint
app.post("/api/subscriptions/cancel", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    console.log('🚫 Cancelling subscription for user:', user.email);
    console.log('📊 Current subscription:', user.subscription);

    // Check if user has an active subscription
    if (!user.subscription || user.subscription.plan === 'free') {
      return res.status(400).json({ error: "No active subscription to cancel" });
    }

    // Store the cancelled plan info for history
    const cancelledPlan = user.subscription.plan;
    const cancelledCredits = user.credits?.subscription || 0;

    // Reset subscription to free plan
    user.subscription = {
      plan: 'free',
      status: 'cancelled',
      start_date: new Date(),
      next_billing_date: null,
      cancelled_date: new Date(),
      previous_plan: cancelledPlan
    };

    // Initialize credits if not exists
    if (!user.credits) {
      user.credits = { subscription: 0, purchased: 0, history: [] };
    }

    // Remove subscription credits but keep purchased credits
    user.credits.subscription = 0;

    // Add cancellation entry to history
    user.credits.history.push({
      type: 'subscription',
      amount: -cancelledCredits, // Negative amount to show credits removed
      timestamp: new Date(),
      description: `Cancelled ${cancelledPlan} subscription - ${cancelledCredits} credits removed`
    });

    console.log('💾 Saving cancelled subscription to database...');
    const savedUser = await user.save();

    console.log('✅ Subscription cancelled successfully:', {
      userId: req.user.userId,
      previousPlan: cancelledPlan,
      newPlan: savedUser.subscription.plan,
      creditsRemoved: cancelledCredits,
      remainingPurchasedCredits: savedUser.credits.purchased
    });

    res.json({
      success: true,
      message: 'Subscription cancelled successfully',
      subscription: {
        plan: savedUser.subscription.plan,
        status: savedUser.subscription.status,
        cancelled_date: savedUser.subscription.cancelled_date,
        previous_plan: cancelledPlan
      },
      credits: {
        subscription: savedUser.credits.subscription,
        purchased: savedUser.credits.purchased,
        removed: cancelledCredits
      }
    });

  } catch (error) {
    console.error('❌ Error cancelling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription', details: error.message });
  }
});

// Catch-all route for SPA (MUST BE LAST)
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

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

// Error handling middleware
// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`🌐 Server accessible at: http://0.0.0.0:${PORT}`)
  console.log(`🌐 Local network access: http://192.168.1.106:${PORT}`)
  console.log(`🌐 Backend URL: ${process.env.VITE_BACKEND_URL}`)
  console.log(`📧 Admin email: ${process.env.ADMIN_USER_EMAIL}`)
})
