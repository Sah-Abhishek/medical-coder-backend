const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ============================================
// S3 CONFIGURATION
// ============================================
const S3_ENABLED = process.env.S3_ENDPOINT_URL && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY;
const S3_FOLDER = 'medical-coder';
const S3_BUCKET = process.env.S3_BUCKET_NAME || 'medextract';

let s3Client = null;
if (S3_ENABLED) {
  s3Client = new S3Client({
    region: 'us-east-1',
    endpoint: process.env.S3_ENDPOINT_URL,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY
    },
    forcePathStyle: true
  });
  console.log('S3 storage enabled:', process.env.S3_ENDPOINT_URL);
} else {
  console.log('S3 storage disabled - missing credentials');
}

/**
 * Generate public URL for S3 object
 */
function getS3PublicUrl(key) {
  if (!key || !process.env.S3_ENDPOINT_URL) return null;
  const endpoint = process.env.S3_ENDPOINT_URL.replace(/\/$/, '');
  return `${endpoint}/${S3_BUCKET}/${key}`;
}

/**
 * Generate presigned URL for private S3 objects (expires in 1 hour)
 */
async function getS3PresignedUrl(key) {
  if (!key || !s3Client) return null;
  try {
    const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
    return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  } catch (error) {
    console.error('Presigned URL error:', error);
    return getS3PublicUrl(key);
  }
}

/**
 * Upload file to S3
 */
async function uploadToS3(buffer, key, contentType) {
  if (!S3_ENABLED || !s3Client) {
    console.log('S3 upload skipped - not enabled');
    return null;
  }

  try {
    const fullKey = `${S3_FOLDER}/${key}`;
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: fullKey,
      Body: buffer,
      ContentType: contentType
    });
    await s3Client.send(command);
    console.log(`Uploaded to S3: ${fullKey}`);
    return fullKey;
  } catch (error) {
    console.error('S3 upload error:', error);
    return null;
  }
}

/**
 * Upload raw document to S3
 */
async function uploadRawFileToS3(documentKey, reportType, rawData, fileType, filename) {
  if (!rawData) return null;

  const contentTypes = {
    pdf: 'application/pdf',
    image: filename ? getMimeType(filename) : 'image/jpeg',
    text: 'text/plain'
  };

  const extensions = {
    pdf: '.pdf',
    image: filename ? getExtension(filename) : '.jpg',
    text: '.txt'
  };

  const key = `${documentKey}/${reportType}_document${extensions[fileType] || '.bin'}`;
  const buffer = fileType === 'text'
    ? Buffer.from(rawData, 'utf-8')
    : Buffer.from(rawData, 'base64');

  return await uploadToS3(buffer, key, contentTypes[fileType] || 'application/octet-stream');
}

/**
 * Upload AI summary to S3 (ALWAYS uploaded)
 */
async function uploadSummaryToS3(documentKey, reportType, summary) {
  if (!summary) return null;
  const key = `${documentKey}/${reportType}_summary.json`;
  const buffer = Buffer.from(JSON.stringify(summary, null, 2), 'utf-8');
  return await uploadToS3(buffer, key, 'application/json');
}

function getMimeType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeTypes = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function getExtension(filename) {
  return '.' + filename.split('.').pop().toLowerCase();
}

// Initialize PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/medextract',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS extractions (
        id SERIAL PRIMARY KEY,
        document_key VARCHAR(255) UNIQUE NOT NULL,
        mr_number VARCHAR(100),
        acct_number VARCHAR(100),
        chart_number VARCHAR(100),
        dos VARCHAR(50),
        hp_text TEXT,
        op_text TEXT,
        hp_file_type VARCHAR(20),
        op_file_type VARCHAR(20),
        s3_hp_doc_key VARCHAR(500),
        s3_op_doc_key VARCHAR(500),
        s3_hp_summary_key VARCHAR(500),
        s3_op_summary_key VARCHAR(500),
        ai_admit_dx VARCHAR(50),
        ai_pdx VARCHAR(50),
        ai_sdx TEXT,
        ai_cpt TEXT,
        ai_modifier VARCHAR(50),
        ai_summary_hp JSONB,
        ai_summary_op JSONB,
        user_admit_dx VARCHAR(50),
        user_pdx VARCHAR(50),
        user_sdx TEXT,
        user_cpt TEXT,
        user_modifier VARCHAR(50),
        accuracy_percentage DECIMAL(5,2),
        accuracy_details JSONB,
        remarks TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add new columns if they don't exist (for existing tables)
    const newColumns = [
      { name: 'hp_file_type', type: 'VARCHAR(20)' },
      { name: 'op_file_type', type: 'VARCHAR(20)' },
      { name: 's3_hp_doc_key', type: 'VARCHAR(500)' },
      { name: 's3_op_doc_key', type: 'VARCHAR(500)' },
      { name: 's3_hp_summary_key', type: 'VARCHAR(500)' },
      { name: 's3_op_summary_key', type: 'VARCHAR(500)' },
      { name: 'ai_summary_hp', type: 'JSONB' },
      { name: 'ai_summary_op', type: 'JSONB' }
    ];

    for (const col of newColumns) {
      try {
        await pool.query(`ALTER TABLE extractions ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
      } catch (e) { /* Column might already exist */ }
    }

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_extractions_mr ON extractions(mr_number)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_extractions_acct ON extractions(acct_number)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_extractions_status ON extractions(status)`);

    console.log('Database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

initDatabase();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    s3_enabled: S3_ENABLED
  });
});

/**
 * Calculate accuracy between AI and user codes
 */
function calculateAccuracy(aiCodes, userCodes) {
  const details = {
    admit_dx: { ai: aiCodes.admit_dx || '', user: userCodes.admit_dx || '', match: false },
    pdx: { ai: aiCodes.pdx || '', user: userCodes.pdx || '', match: false },
    sdx: { ai: [], user: [], matches: [], additions: [], removals: [] },
    cpt: { ai: [], user: [], matches: [], additions: [], removals: [] },
    modifier: { ai: aiCodes.modifier || '', user: userCodes.modifier || '', match: false }
  };

  let totalFields = 0;
  let correctFields = 0;

  if (aiCodes.admit_dx || userCodes.admit_dx) {
    totalFields++;
    if ((aiCodes.admit_dx || '') === (userCodes.admit_dx || '')) {
      correctFields++;
      details.admit_dx.match = true;
    }
  }

  if (aiCodes.pdx || userCodes.pdx) {
    totalFields++;
    if ((aiCodes.pdx || '') === (userCodes.pdx || '')) {
      correctFields++;
      details.pdx.match = true;
    }
  }

  if (aiCodes.modifier || userCodes.modifier) {
    totalFields++;
    if ((aiCodes.modifier || '') === (userCodes.modifier || '')) {
      correctFields++;
      details.modifier.match = true;
    }
  }

  const aiSdx = Array.isArray(aiCodes.sdx) ? aiCodes.sdx : [];
  const userSdx = Array.isArray(userCodes.sdx) ? userCodes.sdx : [];
  details.sdx.ai = aiSdx;
  details.sdx.user = userSdx;
  details.sdx.matches = aiSdx.filter(code => userSdx.includes(code));
  details.sdx.additions = userSdx.filter(code => !aiSdx.includes(code));
  details.sdx.removals = aiSdx.filter(code => !userSdx.includes(code));

  if (aiSdx.length > 0 || userSdx.length > 0) {
    const allSdxCodes = new Set([...aiSdx, ...userSdx]);
    totalFields += allSdxCodes.size;
    correctFields += details.sdx.matches.length;
  }

  const aiCpt = Array.isArray(aiCodes.cpt) ? aiCodes.cpt : [];
  const userCpt = Array.isArray(userCodes.cpt) ? userCodes.cpt : [];
  details.cpt.ai = aiCpt;
  details.cpt.user = userCpt;
  details.cpt.matches = aiCpt.filter(code => userCpt.includes(code));
  details.cpt.additions = userCpt.filter(code => !aiCpt.includes(code));
  details.cpt.removals = aiCpt.filter(code => !userCpt.includes(code));

  if (aiCpt.length > 0 || userCpt.length > 0) {
    const allCptCodes = new Set([...aiCpt, ...userCpt]);
    totalFields += allCptCodes.size;
    correctFields += details.cpt.matches.length;
  }

  const accuracy = totalFields > 0 ? (correctFields / totalFields) * 100 : 100;
  return { percentage: Math.round(accuracy * 100) / 100, details };
}

/**
 * Test endpoint with hardcoded data
 */
app.post('/extract-codes-test', async (req, res) => {
  const {
    hp_text, op_text,
    hp_raw, hp_type, hp_filename,
    op_raw, op_type, op_filename,
    upload_documents = true  // Toggle for document upload
  } = req.body;

  const documentKey = uuidv4();

  // Upload documents to S3 (if toggle is enabled)
  let s3HpDocKey = null;
  let s3OpDocKey = null;

  if (upload_documents) {
    if (hp_raw && hp_type) {
      s3HpDocKey = await uploadRawFileToS3(documentKey, 'hp', hp_raw, hp_type, hp_filename);
    }
    if (op_raw && op_type) {
      s3OpDocKey = await uploadRawFileToS3(documentKey, 'op', op_raw, op_type, op_filename);
    }
  }

  await new Promise(resolve => setTimeout(resolve, 1500));

  // AI Summaries (hardcoded for test)
  const hpSummary = {
    chief_complaint: "Patient presents for scheduled colonoscopy screening.",
    history_of_present_illness: "65-year-old male with coronary artery disease and hypertension.",
    past_medical_history: ["Coronary artery disease", "Essential hypertension", "Hyperlipidemia", "Iron deficiency anemia"],
    medications: ["Aspirin 81mg daily", "Lisinopril 10mg daily", "Atorvastatin 40mg daily"],
    allergies: ["Penicillin - rash", "Sulfa drugs - hives"],
    vital_signs: { bp: "138/82 mmHg", hr: "72 bpm", temp: "98.4°F", spo2: "98%" },
    physical_exam_summary: "Alert, oriented, no acute distress.",
    assessment: "Appropriate candidate for colonoscopy with EGD."
  };

  const opSummary = {
    procedure_performed: ["Colonoscopy with polypectomy", "Esophagogastroduodenoscopy (EGD)"],
    indication: "Screening colonoscopy with history of polyps",
    anesthesia: "Monitored Anesthesia Care (MAC) with Propofol",
    findings: {
      colonoscopy: ["Two 5mm sessile polyps in sigmoid colon - removed", "Internal hemorrhoids grade I"],
      egd: ["Mild erythema in gastric antrum", "Normal esophagus and duodenum"]
    },
    specimens: "3 polyps sent to pathology",
    complications: "None",
    estimated_blood_loss: "Minimal",
    disposition: "Patient tolerated procedure well",
    recommendations: ["Follow up pathology in 1 week", "Repeat colonoscopy in 3 years"]
  };

  // ALWAYS upload AI summaries to S3
  const s3HpSummaryKey = await uploadSummaryToS3(documentKey, 'hp', hpSummary);
  const s3OpSummaryKey = await uploadSummaryToS3(documentKey, 'op', opSummary);

  const extracted = {
    document_key: documentKey,
    chart_number: "V00004918071",
    dos: "09/16/25",
    admit_dx: "D50.9",
    pdx: "K44.9",
    sdx: ["K92.1", "Z86.010", "I25.10", "I10", "E78.5", "Z79.01", "Z79.02", "Z79.899"],
    cpt: ["45378", "43235"],
    modifier: "PT",
    tokens_used: 0,
    mr_number: "M000251535",
    acct_number: "ACC-2024-09162",
    hp_file_type: hp_type || 'text',
    op_file_type: op_type || 'text',
    s3_hp_doc_key: s3HpDocKey,
    s3_op_doc_key: s3OpDocKey,
    s3_hp_summary_key: s3HpSummaryKey,
    s3_op_summary_key: s3OpSummaryKey,
    s3_hp_doc_url: getS3PublicUrl(s3HpDocKey),
    s3_op_doc_url: getS3PublicUrl(s3OpDocKey),
    s3_hp_summary_url: getS3PublicUrl(s3HpSummaryKey),
    s3_op_summary_url: getS3PublicUrl(s3OpSummaryKey)
  };

  try {
    await pool.query(`
      INSERT INTO extractions (
        document_key, mr_number, acct_number, chart_number, dos,
        hp_text, op_text, hp_file_type, op_file_type,
        s3_hp_doc_key, s3_op_doc_key, s3_hp_summary_key, s3_op_summary_key,
        ai_admit_dx, ai_pdx, ai_sdx, ai_cpt, ai_modifier,
        ai_summary_hp, ai_summary_op, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      ON CONFLICT (document_key) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `, [
      documentKey, extracted.mr_number, extracted.acct_number, extracted.chart_number, extracted.dos,
      hp_text, op_text, hp_type || 'text', op_type || 'text',
      s3HpDocKey, s3OpDocKey, s3HpSummaryKey, s3OpSummaryKey,
      extracted.admit_dx, extracted.pdx, JSON.stringify(extracted.sdx), JSON.stringify(extracted.cpt),
      extracted.modifier, JSON.stringify(hpSummary), JSON.stringify(opSummary), 'pending'
    ]);
  } catch (dbError) {
    console.error('Database insert error:', dbError);
  }

  res.json({
    success: true,
    extracted,
    ai_summary: { hp: hpSummary, op: opSummary }
  });
});

/**
 * Extract ICD-10 and CPT codes
 */
app.post('/extract-codes', async (req, res) => {
  try {
    const {
      hp_text, op_text, chart_number,
      hp_raw, hp_type, hp_filename,
      op_raw, op_type, op_filename,
      upload_documents = true  // Toggle for document upload
    } = req.body;

    if (!hp_text && !op_text) {
      return res.status(400).json({ success: false, error: 'At least one of hp_text or op_text is required' });
    }

    const documentKey = uuidv4();

    // Upload documents to S3 (if toggle is enabled)
    let s3HpDocKey = null;
    let s3OpDocKey = null;

    if (upload_documents) {
      if (hp_raw && hp_type) {
        s3HpDocKey = await uploadRawFileToS3(documentKey, 'hp', hp_raw, hp_type, hp_filename);
      }
      if (op_raw && op_type) {
        s3OpDocKey = await uploadRawFileToS3(documentKey, 'op', op_raw, op_type, op_filename);
      }
    }

    let extractedChartNumber = chart_number || 'UNKNOWN';
    let mrNumber = '';
    let acctNumber = '';
    const combinedText = (op_text || '') + (hp_text || '');

    if (!chart_number) {
      const chartMatch = combinedText.match(/V\d+/);
      if (chartMatch) extractedChartNumber = chartMatch[0];
    }

    const mrMatch = combinedText.match(/MR[#:\s]*([A-Z]?\d+)/i);
    if (mrMatch) mrNumber = mrMatch[1];

    const acctMatch = combinedText.match(/(?:Acct|Account)[#:\s]*([A-Z0-9-]+)/i);
    if (acctMatch) acctNumber = acctMatch[1];

    const [codesResult, hpSummary, opSummary] = await Promise.all([
      extractCodesFromText(hp_text || '', op_text || '', extractedChartNumber),
      hp_text ? generateHPSummary(hp_text) : null,
      op_text ? generateOPSummary(op_text) : null
    ]);

    if (!codesResult) {
      return res.status(500).json({ success: false, error: 'Code extraction failed' });
    }

    // ALWAYS upload AI summaries to S3
    const s3HpSummaryKey = await uploadSummaryToS3(documentKey, 'hp', hpSummary);
    const s3OpSummaryKey = await uploadSummaryToS3(documentKey, 'op', opSummary);

    const extracted = {
      ...codesResult,
      document_key: documentKey,
      mr_number: mrNumber,
      acct_number: acctNumber,
      hp_file_type: hp_type || 'text',
      op_file_type: op_type || 'text',
      s3_hp_doc_key: s3HpDocKey,
      s3_op_doc_key: s3OpDocKey,
      s3_hp_summary_key: s3HpSummaryKey,
      s3_op_summary_key: s3OpSummaryKey,
      s3_hp_doc_url: getS3PublicUrl(s3HpDocKey),
      s3_op_doc_url: getS3PublicUrl(s3OpDocKey),
      s3_hp_summary_url: getS3PublicUrl(s3HpSummaryKey),
      s3_op_summary_url: getS3PublicUrl(s3OpSummaryKey)
    };

    try {
      await pool.query(`
        INSERT INTO extractions (
          document_key, mr_number, acct_number, chart_number, dos,
          hp_text, op_text, hp_file_type, op_file_type,
          s3_hp_doc_key, s3_op_doc_key, s3_hp_summary_key, s3_op_summary_key,
          ai_admit_dx, ai_pdx, ai_sdx, ai_cpt, ai_modifier,
          ai_summary_hp, ai_summary_op, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      `, [
        documentKey, mrNumber, acctNumber, extractedChartNumber, codesResult.dos,
        hp_text, op_text, hp_type || 'text', op_type || 'text',
        s3HpDocKey, s3OpDocKey, s3HpSummaryKey, s3OpSummaryKey,
        codesResult.admit_dx, codesResult.pdx,
        JSON.stringify(codesResult.sdx), JSON.stringify(codesResult.cpt),
        codesResult.modifier, JSON.stringify(hpSummary), JSON.stringify(opSummary), 'pending'
      ]);
    } catch (dbError) {
      console.error('Database insert error:', dbError);
    }

    res.json({
      success: true,
      extracted,
      ai_summary: { hp: hpSummary, op: opSummary }
    });

  } catch (error) {
    console.error('Extract codes error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Submit corrections
 */
app.post('/submit-corrections', async (req, res) => {
  try {
    const { document_key, chart_number, original, corrected, remarks } = req.body;

    if (!document_key || !corrected) {
      return res.status(400).json({ success: false, error: 'document_key and corrected data are required' });
    }

    const accuracyResult = calculateAccuracy(original, corrected);

    try {
      await pool.query(`
        UPDATE extractions SET
          user_admit_dx = $1, user_pdx = $2, user_sdx = $3, user_cpt = $4, user_modifier = $5,
          accuracy_percentage = $6, accuracy_details = $7, remarks = $8,
          status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE document_key = $9
      `, [
        corrected.admit_dx, corrected.pdx, JSON.stringify(corrected.sdx), JSON.stringify(corrected.cpt),
        corrected.modifier, accuracyResult.percentage, JSON.stringify(accuracyResult.details),
        remarks, document_key
      ]);
    } catch (dbError) {
      console.error('Database update error:', dbError);
    }

    res.json({
      success: true,
      message: 'Corrections submitted successfully',
      document_key,
      chart_number,
      accuracy: accuracyResult
    });

  } catch (error) {
    console.error('Submit corrections error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get analytics data with S3 URLs
 */
app.get('/analytics', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, document_key, mr_number, acct_number, chart_number, dos,
        hp_text, op_text, hp_file_type, op_file_type,
        s3_hp_doc_key, s3_op_doc_key, s3_hp_summary_key, s3_op_summary_key,
        ai_admit_dx, ai_pdx, ai_sdx, ai_cpt, ai_modifier,
        ai_summary_hp, ai_summary_op,
        user_admit_dx, user_pdx, user_sdx, user_cpt, user_modifier,
        accuracy_percentage, accuracy_details, remarks, status, created_at, updated_at
      FROM extractions WHERE status = 'completed' ORDER BY updated_at DESC LIMIT 100
    `);

    const completedRecords = result.rows;
    const totalRecords = completedRecords.length;
    const avgAccuracy = totalRecords > 0
      ? completedRecords.reduce((sum, r) => sum + (parseFloat(r.accuracy_percentage) || 0), 0) / totalRecords
      : 0;

    const records = await Promise.all(completedRecords.map(async r => {
      let aiSdx = r.ai_sdx;
      let aiCpt = r.ai_cpt;
      let userSdx = r.user_sdx;
      let userCpt = r.user_cpt;

      if (typeof aiSdx === 'string') try { aiSdx = JSON.parse(aiSdx); } catch { aiSdx = []; }
      if (typeof aiCpt === 'string') try { aiCpt = JSON.parse(aiCpt); } catch { aiCpt = []; }
      if (typeof userSdx === 'string') try { userSdx = JSON.parse(userSdx); } catch { userSdx = []; }
      if (typeof userCpt === 'string') try { userCpt = JSON.parse(userCpt); } catch { userCpt = []; }

      return {
        ...r,
        ai_sdx: aiSdx || [],
        ai_cpt: aiCpt || [],
        user_sdx: userSdx || [],
        user_cpt: userCpt || [],
        accuracy_details: r.accuracy_details || {},
        // Add S3 URLs
        s3_hp_doc_url: getS3PublicUrl(r.s3_hp_doc_key),
        s3_op_doc_url: getS3PublicUrl(r.s3_op_doc_key),
        s3_hp_summary_url: getS3PublicUrl(r.s3_hp_summary_key),
        s3_op_summary_url: getS3PublicUrl(r.s3_op_summary_key)
      };
    }));

    res.json({
      success: true,
      statistics: {
        total_records: totalRecords,
        average_accuracy: Math.round(avgAccuracy * 100) / 100,
        completed_today: records.filter(r => new Date(r.updated_at).toDateString() === new Date().toDateString()).length
      },
      records
    });

  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single extraction with S3 URLs
 */
app.get('/extraction/:documentKey', async (req, res) => {
  try {
    const { documentKey } = req.params;
    const result = await pool.query('SELECT * FROM extractions WHERE document_key = $1', [documentKey]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Extraction not found' });
    }

    const record = result.rows[0];

    let aiSdx = record.ai_sdx;
    let aiCpt = record.ai_cpt;
    let userSdx = record.user_sdx;
    let userCpt = record.user_cpt;

    if (typeof aiSdx === 'string') try { aiSdx = JSON.parse(aiSdx); } catch { aiSdx = []; }
    if (typeof aiCpt === 'string') try { aiCpt = JSON.parse(aiCpt); } catch { aiCpt = []; }
    if (typeof userSdx === 'string') try { userSdx = JSON.parse(userSdx); } catch { userSdx = []; }
    if (typeof userCpt === 'string') try { userCpt = JSON.parse(userCpt); } catch { userCpt = []; }

    res.json({
      success: true,
      extraction: {
        ...record,
        ai_sdx: aiSdx || [],
        ai_cpt: aiCpt || [],
        user_sdx: userSdx || [],
        user_cpt: userCpt || [],
        accuracy_details: record.accuracy_details || {},
        s3_hp_doc_url: getS3PublicUrl(record.s3_hp_doc_key),
        s3_op_doc_url: getS3PublicUrl(record.s3_op_doc_key),
        s3_hp_summary_url: getS3PublicUrl(record.s3_hp_summary_key),
        s3_op_summary_url: getS3PublicUrl(record.s3_op_summary_key)
      }
    });

  } catch (error) {
    console.error('Get extraction error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get presigned URL for private S3 object
 */
app.get('/s3-url/:documentKey/:filename', async (req, res) => {
  try {
    const { documentKey, filename } = req.params;
    const key = `${S3_FOLDER}/${documentKey}/${filename}`;
    const url = await getS3PresignedUrl(key);

    if (!url) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    res.json({ success: true, url });
  } catch (error) {
    console.error('Presigned URL error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper functions
async function generateHPSummary(hpText) {
  const prompt = `Analyze HP report:\n${hpText}\n\nReturn JSON: {"chief_complaint":"","history_of_present_illness":"","past_medical_history":[],"medications":[],"allergies":[],"vital_signs":{"bp":"","hr":"","temp":"","spo2":""},"physical_exam_summary":"","assessment":""}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'Return only valid JSON.' }, { role: 'user', content: prompt }],
      max_tokens: 1000, temperature: 0.1, response_format: { type: 'json_object' }
    });
    return JSON.parse(response.choices[0].message.content.trim());
  } catch (error) {
    console.error('HP Summary error:', error);
    return null;
  }
}

async function generateOPSummary(opText) {
  const prompt = `Analyze OP report:\n${opText}\n\nReturn JSON: {"procedure_performed":[],"indication":"","anesthesia":"","findings":{"colonoscopy":[],"egd":[]},"specimens":"","complications":"","estimated_blood_loss":"","disposition":"","recommendations":[]}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'Return only valid JSON.' }, { role: 'user', content: prompt }],
      max_tokens: 1000, temperature: 0.1, response_format: { type: 'json_object' }
    });
    return JSON.parse(response.choices[0].message.content.trim());
  } catch (error) {
    console.error('OP Summary error:', error);
    return null;
  }
}

async function extractCodesFromText(hpText, opText, chartNumber) {
  const prompt = `Extract ICD-10/CPT codes from:\nHP: ${hpText}\nOP: ${opText}\n\nReturn JSON: {"admit_dx":"","pdx":"","sdx":[],"cpt":[],"modifier":""}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'Medical coding specialist. Return only JSON.' }, { role: 'user', content: prompt }],
      max_tokens: 500, temperature: 0.0, response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content.trim());
    const dos = extractDateOfService(opText);

    let sdx = result.sdx || [];
    let cpt = result.cpt || [];
    if (typeof sdx === 'string') sdx = sdx.split(',').map(s => s.trim()).filter(Boolean);
    if (typeof cpt === 'string') cpt = cpt.split(',').map(s => s.trim()).filter(Boolean);

    return { chart_number: chartNumber, dos, admit_dx: result.admit_dx || '', pdx: result.pdx || '', sdx, cpt, modifier: result.modifier || '', tokens_used: response.usage?.total_tokens || 0 };
  } catch (error) {
    console.error('OpenAI extraction error:', error);
    return null;
  }
}

function extractDateOfService(text) {
  if (!text) return '';
  const patterns = [/Date of Service[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i, /DOS[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1]; }
  return '';
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Medical Coding API running on port ${PORT}`));

module.exports = app;
