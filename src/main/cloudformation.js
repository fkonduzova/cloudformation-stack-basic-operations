const through2Concurrent = require('through2-concurrent'),
  AWS = require('aws-sdk'),
  fs = require('fs'),
  Table = require('cli-table2'),
  color = require('bash-color')

const END_OF_STACK_CREATE_STATUSES = new Set([
    'CREATE_COMPLETE',
    'CREATE_FAILED',
    'ROLLBACK_COMPLETE',
    'ROLLBACK_FAILED',
    'DELETE_FAILED',
    'DELETE_COMPLETE'
  ]),
  END_OF_STACK_UPDATE_STATUSES = new Set([
    'UPDATE_COMPLETE',
    'UPDATE_ROLLBACK_COMPLETE',
    'UPDATE_ROLLBACK_FAILED',
    'DELETE_FAILED',
    'DELETE_COMPLETE'
  ]),
  END_OF_STACK_DELETE_STATUSES = new Set([
    'DELETE_FAILED',
    'DELETE_COMPLETE'
  ]),
  SUCCESSFUL_STACK_DEPLOY = 'CREATE_COMPLETE',
  SUCCESSFUL_STACK_UPDATE = 'UPDATE_COMPLETE',
  SUCCESSFUL_STACK_DELETE = 'DELETE_COMPLETE',
  DEFAULT_CONCURRENCY_OPTIONS = {
    delay: 0,
    concurrency: 1
  },
  checkStackStatusPeriod = 5000

class CloudFormationStack {
  constructor () {
    this.cloudFormation = new AWS.CloudFormation()
    this.stackEventsNumber = 0
    this.intervalId = 0
  }

  validateTemplate (opts) {
    const options = opts ? opts : DEFAULT_CONCURRENCY_OPTIONS
    return through2Concurrent.obj({maxConcurrency: options.concurrency},
      (file, enc, callback) => {
        let params = {}
        params.TemplateBody = fs.readFileSync(file.path, enc)
        this.cloudFormation.validateTemplate(params,
          function (err, data) {
            if (err) {
              callback(err)
            } else {
              callback(null, data)
            }
          })
      })
  }

  deploy (params, opts) {
    const options = opts ? opts : DEFAULT_CONCURRENCY_OPTIONS
    return through2Concurrent.obj({maxConcurrency: options.concurrency},
      (file, enc, callback) => {
        params.TemplateBody = fs.readFileSync(file.path, enc)
        this.cloudFormation.createStack(params, (err, data) => {
          if (err) {
            callback(err)
          } else {
            console.log(`Starting deployment of stack: ${params.StackName}`)
            this.checkStackStatusPeriodically({StackName: params.StackName},
              END_OF_STACK_CREATE_STATUSES, SUCCESSFUL_STACK_DEPLOY,
              function (error, result) {
                if (error) {
                  const err =
                    new Error(`Could not create stack: ${params.StackName}`)
                  callback(err)
                } else {
                  console.log(
                    `Successful creation of stack: ${params.StackName}`)
                  callback(null, result)
                }
              })
          }
        })
      })
  }

  update (params, opts) {
    const options = opts ? opts : DEFAULT_CONCURRENCY_OPTIONS
    return through2Concurrent.obj({maxConcurrency: options.concurrency},
      (file, enc, callback) => {
        params.TemplateBody = fs.readFileSync(file.path, enc)
        this.cloudFormation.updateStack(params, (err, data) => {
          if (err) {
            callback(err)
          } else {
            console.log(`Starting update of stack: ${params.StackName}`)
            this.checkStackStatusPeriodically({StackName: params.StackName},
              END_OF_STACK_UPDATE_STATUSES, SUCCESSFUL_STACK_UPDATE,
              function (error, result) {
                if (error) {
                  const err =
                    new Error(`Could not update stack: ${params.StackName}`)
                  callback(err)
                } else {
                  console.log(
                    `Successful update of stack: ${params.StackName}`)
                  callback(null, result)
                }
              })
          }
        })
      })
  }

  deleteStack (params, opts) {
    const options = opts ? opts : DEFAULT_CONCURRENCY_OPTIONS
    return through2Concurrent.obj({maxConcurrency: options.concurrency},
      (file, enc, callback) => {
        this.cloudFormation.deleteStack(params, (err, data) => {
          if (err) {
            callback(err)
          } else {
            console.log(`Starting deletion of stack: ${params.StackName}`)
            this.checkStackStatusPeriodically({StackName: params.StackName},
              END_OF_STACK_DELETE_STATUSES, SUCCESSFUL_STACK_DELETE,
              function (error, result) {
                if (error) {
                  const err =
                    new Error(`Could not delete stack: ${params.StackName}`)
                  callback(err)
                } else {
                  console.log(
                    `Successful deletion of stack: ${params.StackName}`)
                  callback(null, result)
                }
              })
          }
        })
      })
  }

  checkStackStatusPeriodically (
    params, endOfProcessStatuses, successfulProcessStatus, callback) {
    this.intervalId = setInterval(
      this.checkStackStatus.bind(this, params,
        endOfProcessStatuses, successfulProcessStatus, callback),
      checkStackStatusPeriod)
  }

  checkStackStatus (
    params, endOfProcessStatuses, successfulProcessStatus, callback) {
    this.cloudFormation.describeStackEvents(params, (err, data) => {
      if (err) {
        callback(err)
      } else {
        let endOfStackCreationEvent =
          this.logData(data.StackEvents, endOfProcessStatuses,
            successfulProcessStatus)
        if (endOfStackCreationEvent && endOfStackCreationEvent.length > 0) {
          clearInterval(this.intervalId)
          if (endOfStackCreationEvent[0].ResourceStatus !=
            successfulProcessStatus) {
            const error = new Error('Could not perform stack operation')
            callback(error)
          } else {
            callback(null, endOfStackCreationEvent)
          }
        }
      }
    })
  }

  logData (data, endOfProcessStatuses) {
    const firstEvent = data[data.length - 1]
    const newEvents =
      data.slice(0, data.length - this.stackEventsNumber).reverse()
    this.stackEventsNumber = data.length

    let endOfStackCreationEvent = newEvents.filter(
      function (elem) {
        return elem.ResourceType == firstEvent.ResourceType &&
          endOfProcessStatuses.has(elem.ResourceStatus)
      })

    if (newEvents.length > 0) {
      console.log(this.createTable(newEvents).toString())
    }

    return endOfStackCreationEvent
  }

  createTable (data) {
    let table = new Table({
      chars: {
        'top': '',
        'top-mid': '',
        'top-left': '',
        'top-right': ''
        ,
        'bottom': '',
        'bottom-mid': '',
        'bottom-left': '',
        'bottom-right': ''
        ,
        'left': '',
        'left-mid': '',
        'mid': '',
        'mid-mid': ''
        ,
        'right': '',
        'right-mid': '',
        'middle': ' ',
      },
      style: {border: [], header: []},
      colWidths: [12, 33, 30, 47, 70],
      wordWrap: true,
    })
    data.forEach((elem) => {
      let row = []
      row.push(
        `[${elem.Timestamp.toISOString().
          match(/[0-2][0-9]:[0-5][0-9]:[0-5][0-9]/)[0]}]`,
        elem.LogicalResourceId,
        elem.ResourceType,
        this.getStatusColor(elem.ResourceStatus),
        elem.ResourceStatusReason)
      table.push(row)
    })

    return table
  }

  getStatusColor (status) {
    if (status.includes('ROLLBACK') || status.includes('FAILED')) {
      return color.red(status)
    } else if (status.includes('IN_PROGRESS') &&
      !status.includes('ROLLBACK')) {
      return color.yellow(status)
    } else if (status.includes('COMPLETE') && !status.includes('ROLLBACK') &&
      !status.includes('DELETE')) {
      return color.green(status)
    } else {return color.white(status)}
  }
}

module.exports = CloudFormationStack
