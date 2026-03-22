/**
 * Singleton Service Registry
 *
 * Prevents redundant service instantiation across modules.
 * Each service is created once (lazy) and shared.
 *
 * Same pattern as clients.js but for the service/business layer:
 *   Optimizer, CreativePipeline, CopyTemplateEngine, ABTestEngine, AudienceManager
 */
import Optimizer from '../analytics/optimizer.js';
import CreativePipeline from '../content/creative-pipeline.js';
import { CopyTemplateEngine } from '../content/copy-templates.js';
import ABTestEngine from '../content/ab-testing.js';
import AudienceManager from '../content/audience-manager.js';

let _optimizer = null;
let _pipeline = null;
let _templates = null;
let _abEngine = null;
let _audiences = null;

/** Get or create the singleton Optimizer */
export function getOptimizer() {
  if (!_optimizer) _optimizer = new Optimizer();
  return _optimizer;
}

/** Get or create the singleton CopyTemplateEngine */
export function getTemplateEngine() {
  if (!_templates) _templates = new CopyTemplateEngine();
  return _templates;
}

/** Get or create the singleton CreativePipeline (injects shared template engine) */
export function getPipeline() {
  if (!_pipeline) _pipeline = new CreativePipeline(getTemplateEngine());
  return _pipeline;
}

/** Get or create the singleton ABTestEngine (injects shared pipeline) */
export function getABTestEngine() {
  if (!_abEngine) _abEngine = new ABTestEngine(getPipeline());
  return _abEngine;
}

/** Get or create the singleton AudienceManager */
export function getAudienceManager() {
  if (!_audiences) _audiences = new AudienceManager();
  return _audiences;
}

/** Reset all services (useful for testing) */
export function resetServices() {
  _optimizer = null;
  _pipeline = null;
  _templates = null;
  _abEngine = null;
  _audiences = null;
}
