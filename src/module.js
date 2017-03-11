/* globals exports, require */
'use strict'
var _isObject = require('lodash.isobject')
var _isFunction = require('lodash.isfunction')
var _isNumber = require('lodash.isnumber')
var assert = require('assert')
var report
var debug = require('debug')('escomplex:module')
exports.analyse = analyse

var defaultSettings = {
  forin: false,
  logicalor: true,
  newmi: false,
  switchcase: true,
  trycatch: false
}

function analyse (ast, walker, options) {
  // TODO: Asynchronise
  var settings
  var currentReport
  var clearDependencies = true
  var scopeStack = []

  assert(_isObject(ast), 'Invalid syntax tree')
  assert(_isObject(walker), 'Invalid walker')
  assert(_isFunction(walker.walk), 'Invalid walker.walk method')

  settings = _isObject(options) ? options : defaultSettings

  // TODO: loc is moz-specific, move to walker?
  report = createReport(ast.loc)
  debug('Walking the AST:')
  debug(JSON.stringify(ast, null, 2))
  walker.walk(ast, settings, {
    createScope: pushScope,
    popScope: popScope,
    processNode: processNode
  })
  calculateMetrics(settings)

  function processNode (node, syntax) {
    processLloc(node, syntax, currentReport)
    processCyclomatic(node, syntax, currentReport)
    processOperators(node, syntax, currentReport)
    processOperands(node, syntax, currentReport)
    if (processDependencies(node, syntax, clearDependencies)) {
      // HACK: This will fail with async or if other syntax than CallExpression introduces dependencies.
      // TODO: Come up with a less crude approach.
      clearDependencies = false
    }
  }

  function pushScope (name, loc, parameterCount) {
    currentReport = createFunctionReport(name, loc, parameterCount)
    report.functions.push(currentReport)
    report.aggregate.params += parameterCount
    scopeStack.push(currentReport)
  }

  function popScope () {
    scopeStack.pop()
    if (scopeStack.length > 0) {
      currentReport = scopeStack[scopeStack.length - 1]
    } else {
      currentReport = undefined
    }
  }

  return report
}

function createReport (lines) {
  debug('aggregate report: ' + JSON.stringify(createFunctionReport(undefined, lines, 0), null, 2))
  return {
    aggregate: createFunctionReport(undefined, lines, 0),
    dependencies: [],
    functions: []
  }
}

function createFunctionReport (name, lines, params) {
  var result = {
    cyclomatic: 1,
    halstead: createInitialHalsteadState(),
    name: name,
    params: params,
    sloc: {
      logical: 0
    }
  }
  if (_isObject(lines)) {
    debug('Calculating line information...')
    debug('start line: ' + lines.start.line)
    debug('end line: ' + lines.end.line)
    result.line = lines.start.line
    result.sloc.physical = lines.end.line - lines.start.line + 1
    debug('physical lines: ' + result.sloc.physical)
  }
  return result
}

function createInitialHalsteadState () {
  return {
    operands: createInitialHalsteadItemState(),
    operators: createInitialHalsteadItemState()
  }
}

function createInitialHalsteadItemState () {
  return {
    distinct: 0,
    identifiers: [],
    total: 0
  }
}

function processLloc (node, syntax, currentReport) {
  incrementCounter(node, syntax, 'lloc', incrementLogicalSloc, currentReport)
}

function incrementCounter (node, syntax, name, incrementFn, currentReport) {
  var amount = syntax[name]
  if (_isNumber(amount)) {
    incrementFn(currentReport, amount)
  } else if (_isFunction(amount)) {
    incrementFn(currentReport, amount(node))
  }
}

function incrementLogicalSloc (currentReport, amount) {
  debug('incrementing sloc by ' + amount)
  report.aggregate.sloc.logical += amount
  if (currentReport) {
    currentReport.sloc.logical += amount
  }
}

function processCyclomatic (node, syntax, currentReport) {
  incrementCounter(node, syntax, 'cyclomatic', incrementCyclomatic, currentReport)
}

function incrementCyclomatic (currentReport, amount) {
  report.aggregate.cyclomatic += amount
  if (currentReport) {
    currentReport.cyclomatic += amount
  }
}

function processOperators (node, syntax, currentReport) {
  processHalsteadMetric(node, syntax, 'operators', currentReport)
}

function processOperands (node, syntax, currentReport) {
  processHalsteadMetric(node, syntax, 'operands', currentReport)
}

function processHalsteadMetric (node, syntax, metric, currentReport) {
  if (Array.isArray(syntax[metric])) {
    syntax[metric].forEach(function (s) {
      var identifier
      if (_isFunction(s.identifier)) {
        identifier = s.identifier(node)
      } else {
        identifier = s.identifier
      }
      if (_isFunction(s.filter) === false || s.filter(node) === true) {
        halsteadItemEncountered(currentReport, metric, identifier)
      }
    })
  }
}

function halsteadItemEncountered (currentReport, metric, identifier) {
  if (currentReport) {
    incrementHalsteadItems(currentReport, metric, identifier)
  }
  incrementHalsteadItems(report.aggregate, metric, identifier)
}

function incrementHalsteadItems (baseReport, metric, identifier) {
  incrementDistinctHalsteadItems(baseReport, metric, identifier)
  incrementTotalHalsteadItems(baseReport, metric)
}

function incrementDistinctHalsteadItems (baseReport, metric, identifier) {
  if (Object.prototype.hasOwnProperty(identifier)) {
    // Avoid clashes with built-in property names.
    incrementDistinctHalsteadItems(baseReport, metric, '_' + identifier)
  } else {
    if (isHalsteadMetricDistinct(baseReport, metric, identifier)) {
      recordDistinctHalsteadMetric(baseReport, metric, identifier)
      incrementHalsteadMetric(baseReport, metric, 'distinct')
    }
  }
}

function isHalsteadMetricDistinct (baseReport, metric, identifier) {
  return baseReport.halstead[metric].identifiers.indexOf(identifier) === -1
}

function recordDistinctHalsteadMetric (baseReport, metric, identifier) {
  baseReport.halstead[metric].identifiers.push(identifier)
}

function incrementHalsteadMetric (baseReport, metric, type) {
  if (baseReport) {
    baseReport.halstead[metric][type] += 1
  }
}

function incrementTotalHalsteadItems (baseReport, metric) {
  incrementHalsteadMetric(baseReport, metric, 'total')
}

function processDependencies (node, syntax, clearDependencies) {
  var dependencies
  if (_isFunction(syntax.dependencies)) {
    dependencies = syntax.dependencies(node, clearDependencies)
    if (_isObject(dependencies) || Array.isArray(dependencies)) {
      report.dependencies = report.dependencies.concat(dependencies)
    }
    return true
  }
  return false
}

function calculateMetrics (settings) {
  var count
  var indices
  var sums
  var averages
  count = report.functions.length
  debug('calculateMetrics: ' + count + ' functions found.')
  indices = {
    cyclomatic: 1,
    effort: 2,
    loc: 0,
    params: 3
  }
  sums = [
    0,
    0,
    0,
    0
  ]
  report.functions.forEach(function (functionReport) {
    calculateCyclomaticDensity(functionReport)
    calculateHalsteadMetrics(functionReport.halstead)
    sumMaintainabilityMetrics(sums, indices, functionReport)
  })
  calculateCyclomaticDensity(report.aggregate)
  calculateHalsteadMetrics(report.aggregate.halstead)
  if (count === 0) {
    // Sane handling of modules that contain no functions.
    sumMaintainabilityMetrics(sums, indices, report.aggregate)
    count = 1
  }
  averages = sums.map(function (sum) {
    return sum / count
  })
  report.maintainability = calculateMaintainabilityIndex(averages[indices.effort], averages[indices.cyclomatic], averages[indices.loc], settings.newmi)
  Object.keys(indices).forEach(function (index) {
    report[index] = averages[indices[index]]
  })
}

function calculateCyclomaticDensity (data) {
  data.cyclomaticDensity = (data.cyclomatic / data.sloc.logical) * 100
}

function calculateHalsteadMetrics (data) {
  data.length = data.operators.total + data.operands.total
  if (data.length === 0) {
    nilHalsteadMetrics(data)
  } else {
    data.vocabulary = data.operators.distinct + data.operands.distinct
    data.difficulty = (data.operators.distinct / 2) * (data.operands.distinct === 0 ? 1 : data.operands.total / data.operands.distinct)
    data.volume = data.length * (Math.log(data.vocabulary) / Math.log(2))
    data.effort = data.difficulty * data.volume
    data.bugs = data.volume / 3000
    data.time = data.effort / 18
  }
}

function nilHalsteadMetrics (data) {
  data.vocabulary = data.difficulty = data.volume = data.effort = data.bugs = data.time = 0
}

function sumMaintainabilityMetrics (sums, indices, data) {
  sums[indices.loc] += data.sloc.logical
  sums[indices.cyclomatic] += data.cyclomatic
  sums[indices.effort] += data.halstead.effort
  sums[indices.params] += data.params
}

function calculateMaintainabilityIndex (averageEffort, averageCyclomatic, averageLoc, newmi) {
  if (averageCyclomatic === 0) {
    throw new Error('Encountered function with cyclomatic complexity zero!')
  }
  var maintainability = 171 - (3.42 * Math.log(averageEffort)) - (0.23 * Math.log(averageCyclomatic)) - (16.2 * Math.log(averageLoc))
  if (maintainability > 171) {
    maintainability = 171
  }
  if (newmi) {
    maintainability = Math.max(0, (maintainability * 100) / 171)
  }
  return maintainability
}
