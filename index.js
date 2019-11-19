
const requireg = require('requireg');
const { cropLongData } = require('@kronoslive/codeceptjs-utils');
const { generateCorrelationId } = require('@kronoslive/codeceptjs-utils');
const path = require('path');

const codeceptjsPath = path.resolve(global.codecept_dir, './node_modules/codeceptjs');
// eslint-disable-next-line import/no-dynamic-require
const { recorder } = require(codeceptjsPath);

let WSClient;

let mochawesome;
let utils;

class WS extends Helper {
  constructor(config) {
    super(config);
    WSClient = requireg('ws');
    this._validateConfig(config);
  }

  _validateConfig(config) {
    this.options = {
      connectionEstablishTimeout: 2000, // ms
      waitResponse: true,
      strictWaiting: false,
    };
    this.isRunning = false;
    this.messageQuery = {};
    this.currentCorrelationId = '';

    // override defaults with config
    Object.assign(this.options, config);

    if (!this.options.endpoint) {
      throw new Error(`
        WS requires at endpoint to be set.
        Check your codeceptjs config file to ensure this is set properly
          {
            "helpers": {
              "WS": {
                "endpoint": "YOUR_WS_HOST"
              }
            }
          }
        `);
    }
  }

  // eslint-disable-next-line consistent-return
  static _checkRequirements() {
    try {
      requireg('ws');
    } catch (e) {
      return ['ws'];
    }
    // eslint-disable-next-line consistent-return
  }

  _beforeSuite() {
    mochawesome = this.helpers.Mochawesome;
    utils = this.helpers.Utils;
    return true;
  }

  _launchWS() {
    this.ws = new WSClient(this.options.endpoint);

    this.ws.on('error', (err) => {
      recorder.catch(() => {
        throw err;
      });
    });


    try {
      this.ws.on('message', (data) => {
        let object;
        try {
          object = JSON.parse(data);
        } catch (err) {
          console.error(err);
        }
        const correlationId = object.headers['Correlation-Id'];
        if (!correlationId) {
          this.debug(`correlation id is missing for message ${data}`);
          mochawesome.addMochawesomeContext({
            title: 'Got message without correlationId!',
            value: cropLongData(data),
          });
        }
        if (this.messageQuery[correlationId]) this.messageQuery[correlationId].push(object);
        else this.messageQuery[correlationId] = [object];
      });
    } catch (err) {
      console.error(err);
      return true;
    }

    return utils.waitUntil(() => Promise.resolve(this.ws.readyState === 1), this.options.connectionEstablishTimeout, `We didn't establish ws connect for the allotted 
            time (${this.options.connectionEstablishTimeout} ms). Current readyState: ${this.ws.readyState}.`)
      .then(() => {
        this.isRunning = true;
        return true;
      });
  }

  _after() {
    this.messageQuery = {};
    this.currentCorrelationId = '';
  }

  _finishTest() {
    if (this.isRunning) return this.ws.close(1000);
    return true;
  }

  _failed() {

  }

  /**
   * Send message by established ws connection. It generates new correlationId for each new message, but you can
   * pass specified correlationId
   * @param message - message that we have to send. Can be string or object
   * @param correlationId - (optional). specified correlationId
   * @returns {*}
   *
   * ```js
   * I.sendMessage('{"uri":"/tokens","method":"POST","headers":{"Authorization":"Basic Mytoken"}}');
   * I.sendMessage({"uri":"/tokens","method":"POST","headers":{"Authorization":"Basic Mytoken"}});
   * I.sendMessage({"uri":"/tokens","method":"POST","headers":{"Authorization":"Basic
     *     cGV0ZXIudGhpZWxAdnR1cmJvLmNvLnVrOnBhc3N3b3Jk"}}, 'My_corrId');
   * ```
   */
  sendMessage(message, correlationId, amountOfMessages = 1, timeout) {
    return this._sendMessageWithoutLogging(message, correlationId)
      .then((res) => mochawesome.addMochawesomeContext({
        title: 'Send WS request',
        value: res,
      })).then(() => {
        if (this.options.waitResponse) {
          return this.waitResponses(amountOfMessages, correlationId, timeout);
        }
        return true;
      });
  }

  /**
   * Basic sendMessage without logging
   * @param message  - message that we have to send. Can be string or object
   * @param correlationId - (optional). specified correlationId
   * @returns {Promise.<TResult>}
   * @private
   */
  _sendMessageWithoutLogging(message, correlationId) {
    correlationId = correlationId || generateCorrelationId();
    let obj;
    this.currentCorrelationId = correlationId;
    if (typeof message === 'string') obj = JSON.parse(message);
    else obj = message;
    obj.headers['Correlation-Id'] = this.currentCorrelationId;
    const request = JSON.stringify(obj, null, 2);
    if (this.isRunning) {
      return Promise.resolve(this.ws.send(request)).then(() => request);
    }
    return this._launchWS().then(() => this._sendMessageWithoutLogging(message, correlationId));
  }

  /**
   * Grab current correlationId (that was generated for latest message)
   * @returns {string|*}
   *
   * ```js
   * let corrId = yield I.grabCurrentCorrelationId();
   * ```
   */
  grabCurrentCorrelationId() {
    return this.currentCorrelationId;
  }

  /**
   * Grab current correlationId (that was generated for latest message)
   * @returns {string|*}
   *
   * ```js
   * let corrId = yield I.grabCurrentCorrelationId();
   * ```
   */
  grabMessagesByCorrelationId(correlationId = this.currentCorrelationId) {
    return this.messageQuery[correlationId];
  }

  /**
   * Validate that latest response message has specified JSON schema
   * @param schema - path to JSON schema file. is relative to schemas folder
   * @param data - (optional) - specify data that should be validated (by default first response message for current
   *     CorrelationID)
   *
   * ```
   * I.seeWsResponseHasValidJsonSchema('authPassed.json');
   * ```
   */
  seeWsResponseHasValidJsonSchema(schema, params, data) {
    data = data || this.messageQuery[this.currentCorrelationId][0];
    return utils.seeDataHasValidJsonSchema(schema, params, data);
  }

  expectWsMessage(predicate, timeout = this.options.waitResponse, correllationId = this.currentCorrelationId) {
    const seen = {};
    let predicateErr;

    return utils.waitUntil(async () => Promise.resolve((this.messageQuery[correllationId] || [])
      .find((msg, i) => {
        try {
          if (!seen[i]) {
            seen[i] = true;
            return predicate(msg);
          }
          return false;
        } catch (err) {
          predicateErr = err;
          return true;
        }
      })), timeout, 'timeout', 100)
      .then(async () => {
        if (predicateErr) {
          throw new Error(`predicate return err (${predicateErr.code}), but it should return boolean value`);
        }
        const messages = await this.messageQuery[correllationId];
        mochawesome.addMochawesomeContext({
          title: `Wait messages with predicate for correllationId ${correllationId}`,
          value: predicate.toString(),
        });
        mochawesome.addMochawesomeContext({
          title: 'Latest request',
          value: cropLongData(messages[messages.length - 1]),
        });
      }).catch(async (err) => {
        const messages = await this.messageQuery[correllationId];
        mochawesome.addMochawesomeContext({
          title: `Wait messages with predicate for correllationId ${correllationId}`,
          value: predicate.toString(),
        });
        mochawesome.addMochawesomeContext({
          title: 'Latest request',
          value: cropLongData(messages[messages.length - 1]),
        });
        if (err.message === 'timeout') {
          throw new Error(`timeout while expecting message with correllationId ${correllationId} with ${predicate}`);
        } else throw err;
      });
  }

  /**
   * Waits response messages by correlationId
   * @param amountOfMessages - (optional) Amount of messages that we have to receive for specified correlationId.
   *     Default 1
   * @param correlationId - (optional) specified correlationId
   * @param timeout - (optional) after that time we will throw error message. In ms
   * @returns {Promise.<TResult>|ajv.Thenable<any>|*}
   *
   * ```js
   * I.waitResponses();
   * ```
   */
  waitResponses(amountOfMessages = 1, correlationId = this.currentCorrelationId, timeout) {
    return this._waitResponsesWithoutLogging(amountOfMessages, correlationId, timeout).then(() => {
      mochawesome.addMochawesomeContext({
        title: 'Get WS responses',
        value: cropLongData(this.messageQuery[correlationId]),
      });
      if (this.messageQuery[correlationId].length === 1) return this.messageQuery[correlationId][0];
      return this.messageQuery[correlationId];
    }).catch((err) => {
      if (err.message === 'timeout') {
        mochawesome.addMochawesomeContext({
          title: 'Get WS responses',
          value: cropLongData(this.messageQuery[correlationId]),
        });
        throw Error(`We didn't receive enough amount of messages (${amountOfMessages}) for the allotted 
        time for correlationId (${correlationId}). Get (${(this.messageQuery[correlationId])
  ? this.messageQuery[correlationId].length : 0}). 
        Check additional context for details about messages`);
      } else throw err;
    });
  }

  /**
   * Base WaitResponses without logging
   * @param amountOfMessages (optional) Amount of messages that we have to receive for specified correlationId. Default
   *     1
   * @param correlationId - (optional) specified correlationId
   * @param timeout - (optional) after that time we will throw error message. In ms
   * @returns {*}
   */
  _waitResponsesWithoutLogging(amountOfMessages = 1, correlationId = this.currentCorrelationId, timeout) {
    return utils.waitUntil(() => Promise.resolve(this.messageQuery[correlationId] && (this.options.strictWaiting
      ? this.messageQuery[correlationId].length === amountOfMessages : this.messageQuery[correlationId].length >= amountOfMessages)), timeout);
  }

  dontExpectMoreResponsesThan(amountOfMessages = 1, timeout = 1500, correlationId = this.currentCorrelationId) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          mochawesome.addMochawesomeContext({
            title: 'Get WS responses',
            value: cropLongData(this.messageQuery[correlationId]),
          });
          if (this.messageQuery[correlationId]
          && this.messageQuery[correlationId].length <= amountOfMessages) {
            if (this.messageQuery[correlationId].length === 1) resolve(this.messageQuery[correlationId][0]);
            resolve(this.messageQuery[correlationId]);
          } else {
            reject(new Error(`We received more messages than (${amountOfMessages}) for the allotted 
        time for correlationId (${correlationId}). Got (${(this.messageQuery[correlationId])
  ? this.messageQuery[correlationId].length : 0}) messages. 
        Check additional context for details about messages`));
          }
        } catch (err) {
          reject(err);
        }
      }, timeout);
    });
  }

  /**
   * Wait a message from /subscribe method that will contains order with specified order status
   * @param orderId
   * @param status
   * @param ammountOfMessages
   * @param correlationId
   * @returns {Promise.<T>}
   */
  waitMessageWithOrderStatus(
    orderId, status, timeout = this.options.waitForTimeout, ammountOfMessages = 1,
    correlationId = this.currentCorrelationId,
  ) {
    return this._waitResponsesWithoutLogging(ammountOfMessages, correlationId, timeout).then(() => {
      if (
        this.messageQuery[correlationId][ammountOfMessages - 1].body.orders.every((order) => order.orderId !== orderId || order.status !== status)
      ) {
        return this.waitMessageWithOrderStatus(orderId, status, timeout, ammountOfMessages + 1, correlationId);
      }
      return {
        messageNumber: ammountOfMessages - 1,
        message: this.messageQuery[correlationId][ammountOfMessages - 1],
      };
    }).catch((err) => {
      if (err.message === 'timeout') {
        const ordersSteps = [];
        this.messageQuery[correlationId].forEach((message) => {
          message.body.orders.forEach((order) => {
            if (order.orderId === orderId) ordersSteps.push(order);
          });
        });
        mochawesome.addMochawesomeContext({
          title: 'Order data from messages',
          value: cropLongData(ordersSteps),
        });
        throw Error(`We didn't receive message for order (${orderId}) with status (${status}). Check additional context to see what messages for this order we receive`);
      } else throw err;
    });
  }

  /**
   * Waits when /orders/${orderId} will return order with specifeted state
   * @param token
   * @param orderId
   * @param state
   * @param timeout
   * @returns {Promise.<TResult>}
   */
  waitOrder(orderId, state, timeout, token = this.token) {
    const message = {
      uri: `/orders/${orderId}`,
      method: 'get',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: {},
    };
    let lastRequest;
    let lastMessage;
    return utils.waitUntil(() => this._sendMessageWithoutLogging(message).then((res) => {
      lastRequest = res;
      return this._waitResponsesWithoutLogging(1, this.currentCorrelationId, timeout).then(() => {
        // eslint-disable-next-line prefer-destructuring
        lastMessage = this.messageQuery[this.currentCorrelationId][0];
        return lastMessage.status === 200 && state(lastMessage.body);
      });
    }), timeout, 'timeout', 500)
      .then(() => {
        mochawesome.addMochawesomeContext({
          title: 'Send WS request',
          value: cropLongData(lastRequest),
        });
        mochawesome.addMochawesomeContext({
          title: 'Latest order data',
          value: cropLongData(lastMessage),
        });
      }).catch((err) => {
        mochawesome.addMochawesomeContext({
          title: 'Send WS request',
          value: cropLongData(lastRequest),
        });
        mochawesome.addMochawesomeContext({
          title: 'Latest order data',
          value: cropLongData(lastMessage),
        });
        if (err.message === 'timeout') {
          throw new Error(`We didn't receive message for order (${orderId}) with state (${state.toString()}). Check additional context to see latest message for this order we receive`);
        } else throw err;
      });
  }
}

module.exports = WS;
