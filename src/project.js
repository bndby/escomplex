'use strict'

var _isString = require('lodash.isstring')
var assert = require('assert')
var path = require('path')
var moduleAnalyser = require('./module')

exports.analyse = analyse
exports.processResults = processResults

function analyse (modules, walker, options) {
  // TODO: Asynchronize.
  var reports
  options = options || {}
  assert(Array.isArray(modules), 'Invalid modules')

  reports = modules.map(function (m) {
    var report
    assert(_isString(m.path) && m.path.length > 0, 'Invalid path')
    try {
      report = moduleAnalyser.analyse(m.ast, walker, options)
      report.path = m.path
      return report
    } catch (error) {
      // These error messages are useless unless they contain the module path.
      error.message = m.path + ': ' + error.message
      throw error
    }
  }, [])
  if (options.skipCalculation) {
    return {
      reports: reports
    }
  }
  return processResults({
    reports: reports
  }, options.noCoreSize)
}

function processResults (result, noCoreSize) {
  createAdjacencyMatrix(result)
  if (!noCoreSize) {
    createVisibilityMatrix(result)
    setCoreSize(result)
  }
  calculateAverages(result)
  return result
}

function createAdjacencyMatrix (result) {
  var adjacencyMatrix = new Array(result.reports.length)
  var density = 0
  result.reports.sort(function (lhs, rhs) {
    return comparePaths(lhs.path, rhs.path)
  }).forEach(function (ignore, x) {
    adjacencyMatrix[x] = new Array(result.reports.length)
    result.reports.forEach(function (ignore, y) {
      adjacencyMatrix[x][y] = getAdjacencyMatrixValue(result.reports, x, y)
      if (adjacencyMatrix[x][y] === 1) {
        density += 1
      }
    })
  })
  result.adjacencyMatrix = adjacencyMatrix
  result.firstOrderDensity = percentifyDensity(density, adjacencyMatrix)
}

function comparePaths (lhs, rhs) {
  var lsplit = lhs.split(path.sep)
  var rsplit = rhs.split(path.sep)
  if (lsplit.length < rsplit.length || (lsplit.length === rsplit.length && lhs < rhs)) {
    return -1
  }
  if (lsplit.length > rsplit.length || (lsplit.length === rsplit.length && lhs > rhs)) {
    return 1
  }
  return 0
}

function getAdjacencyMatrixValue (reports, x, y) {
  if (x === y) {
    return 0
  }
  if (doesDependencyExist(reports[x], reports[y])) {
    return 1
  }
  return 0
}

function doesDependencyExist (from, to) {
  return from.dependencies.reduce(function (result, dependency) {
    if (result === false) {
      return checkDependency(from.path, dependency, to.path)
    }
    return true
  }, false)
}

function checkDependency (from, dependency, to) {
  if (isCommonJSDependency(dependency)) {
    if (isInternalCommonJSDependency(dependency)) {
      return isDependency(from, dependency, to)
    }
    return false
  }
  return isDependency(from, dependency, to)
}

function isCommonJSDependency (dependency) {
  return dependency.type === 'CommonJS'
}

function isInternalCommonJSDependency (dependency) {
  return dependency.path[0] === '.' && (dependency.path[1] === path.sep || (dependency.path[1] === '.' && dependency.path[2] === path.sep))
}

function isDependency (from, dependency, to) {
  var dependencyPath = dependency.path
  var fromFileAbsolutePath = path.resolve(from)
  var toFileAbsolutePath = path.resolve(to)
  var dependencyAbsolutePath = path.resolve(path.dirname(fromFileAbsolutePath), dependencyPath)
  if (path.extname(dependencyPath) === '') {
    var index = path.join(dependencyAbsolutePath, 'index.js')
    if (index === toFileAbsolutePath) {
      return true
    } else {
      dependencyAbsolutePath += path.extname(to)
    }
  }
  return dependencyAbsolutePath === toFileAbsolutePath
}

function percentifyDensity (density, matrix) {
  return percentify(density, matrix.length * matrix.length)
}

function percentify (value, limit) {
  if (limit === 0) {
    return 0
  }
  return (value / limit) * 100
}

// Implementation of floydWarshall alg for calculating visibility matrix in O(n^3) instead of O(n^4) with successive raising of powers

function createVisibilityMatrix (result) {
  var changeCost = 0
  var visibilityMatrix
  var matrixLen
  var k
  var i
  var j
  visibilityMatrix = adjacencyToDistMatrix(result.adjacencyMatrix)
  matrixLen = visibilityMatrix.length
  for (k = 0; k < matrixLen; k += 1) {
    for (i = 0; i < matrixLen; i += 1) {
      for (j = 0; j < matrixLen; j += 1) {
        if (visibilityMatrix[i][j] > visibilityMatrix[i][k] + visibilityMatrix[k][j]) {
          visibilityMatrix[i][j] = visibilityMatrix[i][k] + visibilityMatrix[k][j]
        }
      }
    }
  }

  // Convert back from a distance matrix to adjacency matrix, while also calculating change cost
  visibilityMatrix = visibilityMatrix.map(function (row, rowIndex) {
    return row.map(function (value, columnIndex) {
      if (value < Infinity) {
        changeCost += 1
        if (columnIndex !== rowIndex) {
          return 1
        }
      }
      return 0
    })
  })
  result.visibilityMatrix = visibilityMatrix
  result.changeCost = percentifyDensity(changeCost, visibilityMatrix)
}

function adjacencyToDistMatrix (matrix) {
  var distMatrix = []
  var i
  var j
  var value
  for (i = 0; i < matrix.length; i += 1) {
    distMatrix.push([])
    for (j = 0; j < matrix[i].length; j += 1) {
      value = null
      if (i === j) {
        value = 1
      } else {
        // Where we have 0, set distance to Infinity
        value = matrix[i][j] || Infinity
      }
      distMatrix[i][j] = value
    }
  }
  return distMatrix
}

function setCoreSize (result) {
  var fanIn
  var fanOut
  var boundaries
  var coreSize
  if (result.firstOrderDensity === 0) {
    result.coreSize = 0
    return
  }
  fanIn = new Array(result.visibilityMatrix.length)
  fanOut = new Array(result.visibilityMatrix.length)
  boundaries = {}
  coreSize = 0
  result.visibilityMatrix.forEach(function (row, rowIndex) {
    fanIn[rowIndex] = row.reduce(function (sum, value, valueIndex) {
      if (rowIndex === 0) {
        fanOut[valueIndex] = value
      } else {
        fanOut[valueIndex] += value
      }
      return sum + value
    }, 0)
  })

  // Boundary values can also be chosen by looking for discontinuity in the
  // Distribution of values, but I've chosen the median to keep it simple.
  boundaries.fanIn = getMedian(fanIn.slice())
  boundaries.fanOut = getMedian(fanOut.slice())
  result.visibilityMatrix.forEach(function (ignore, index) {
    if (fanIn[index] >= boundaries.fanIn && fanOut[index] >= boundaries.fanOut) {
      coreSize += 1
    }
  })
  result.coreSize = percentify(coreSize, result.visibilityMatrix.length)
}

function getMedian (values) {
  values.sort(compareNumbers)
  if (values.length % 2 === 1) {
    return values[(values.length - 1) / 2]
  }
  return (values[(values.length - 2) / 2] + values[values.length / 2]) / 2
}

function compareNumbers (lhs, rhs) {
  if (lhs < rhs) {
    return -1
  }
  if (lhs > rhs) {
    return 1
  }
  return 0
}

function calculateAverages (result) {
  var sums
  var divisor
  sums = {
    cyclomatic: 0,
    effort: 0,
    loc: 0,
    maintainability: 0,
    params: 0
  }
  if (result.reports.length === 0) {
    divisor = 1
  } else {
    divisor = result.reports.length
  }
  result.reports.forEach(function (report) {
    Object.keys(sums).forEach(function (key) {
      sums[key] += report[key]
    })
  })
  Object.keys(sums).forEach(function (key) {
    result[key] = sums[key] / divisor
  })
}
