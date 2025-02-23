import { decodeAddress } from '@polkadot/keyring';
import axios from 'axios';
import dotenv from 'dotenv';
import * as mSDK from 'matrix-js-sdk';

import { isDripSuccessResponse } from '../guards';
import type {
  BalanceResponse,
  DripResponse,
  EnvNameBot,
  EnvVar,
} from '../types';
import { checkEnvVariables, getEnvVariable, logger } from '../utils';

dotenv.config();

const envVars: EnvVar<EnvNameBot> = {
  BACKEND_URL: {
    default: 'http://localhost:5555',
    required: false,
    secret: false,
    type: 'string',
  },
  DRIP_AMOUNT: { default: 0.5, required: false, secret: false, type: 'number' },
  FAUCET_IGNORE_LIST: {
    default: '',
    required: false,
    secret: false,
    type: 'string',
  },
  MATRIX_ACCESS_TOKEN: { required: true, secret: true, type: 'string' },
  MATRIX_BOT_USER_ID: { required: true, secret: false, type: 'string' },
  NETWORK_DECIMALS: {
    default: 12,
    required: false,
    secret: false,
    type: 'number',
  },
  NETWORK_UNIT: {
    default: 'UNIT',
    required: false,
    secret: false,
    type: 'string',
  },
};

checkEnvVariables(envVars);

const botUserId = getEnvVariable('MATRIX_BOT_USER_ID', envVars) as string;
const accessToken = getEnvVariable('MATRIX_ACCESS_TOKEN', envVars) as string;
const baseURL = getEnvVariable('BACKEND_URL', envVars) as string;
const decimals = getEnvVariable('NETWORK_DECIMALS', envVars) as number;
const unit = getEnvVariable('NETWORK_UNIT', envVars) as string;
const defaultDripAmount = getEnvVariable('DRIP_AMOUNT', envVars) as number;
const ignoreList = (getEnvVariable('FAUCET_IGNORE_LIST', envVars) as string)
  .split(',')
  .map((item) => item.replace('"', ''));

// Show the ignore list at start if any
if (ignoreList.length > 0) {
  logger.info(`Ignore list: (${ignoreList.length} entries)`);
  ignoreList.forEach((account) => logger.info(` '${account}'`));
}

const bot = mSDK.createClient({
  accessToken,
  baseUrl: 'https://matrix.org',
  localTimeoutMs: 10000,
  userId: botUserId,
});

const ax = axios.create({
  baseURL,
  timeout: 10000,
});

const sendMessage = (roomId: string, msg: string) => {
  bot
    .sendEvent(
      roomId,
      'm.room.message',
      { body: msg, msgtype: 'm.text' },
      '',
      (err) => {
        if (err) logger.error(err);
      }
    )
    .catch((e) => logger.error(e));
};

const printHelpMessage = (roomId: string, message = '') =>
  sendMessage(
    roomId,
    `${message ? `${message} - ` : ''}The following commands are supported:
!balance - Get the faucet's balance.
!drip <Address>[:ParachainId] - Send ${unit}s to <Address>, if the optional suffix \`:SomeParachainId\` is given a teleport will be issued.
!help - Print this message`
  );

bot.on('RoomMember.membership', (_, member: Record<string, string>) => {
  if (member.membership === 'invite' && member.userId === botUserId) {
    bot
      .joinRoom(member.roomId)
      .then(() => {
        logger.info(`Auto-joined ${member.roomId}.`);
      })
      .catch((e) => logger.error('⭕ Auto-join error', e));
  }
});

bot.on('Room.timeline', (event: mSDK.MatrixEvent) => {
  const sender = event.getSender();
  const roomId = event.getRoomId();
  const { body } = event.getContent();

  // only act on messages
  if (event.getType() !== 'm.room.message') {
    return;
  }

  // ignore our own messages or when sender is undefined
  if (!sender || sender === botUserId) {
    return;
  }

  // Ignore blacklisted accounts
  if (ignoreList.includes(sender)) {
    logger.warn(`🏴‍☠️ Ignored request from an ignored account: ${sender}`);
    return;
  }

  logger.debug(`Processing request from ${sender}`);

  let dripAmount = defaultDripAmount;
  const [action, arg0, arg1] = body.split(' ');

  if (action === '!balance') {
    ax.get<BalanceResponse>('/balance')
      .then((res) => {
        const balance = Number(res.data.balance);

        sendMessage(
          roomId,
          `The faucet has ${balance / 10 ** decimals} ${unit}s remaining.`
        );
      })
      .catch((e) => {
        sendMessage(roomId, 'An error occured, please check the server logs.');
        logger.error('⭕ An error occured when checking the balance', e);
      });
  } else if (action === '!drip') {
    if (!arg0) {
      logger.warn('Address not provided, skipping');
      return;
    }

    const arg0_processed = arg0.trim().split(':');
    const address = arg0_processed[0];
    const parachain_id = arg0_processed[1] ? arg0_processed[1] : '';
    logger.debug(
      `Processed receiver to address ${address} and parachain id ${parachain_id}`
    );

    try {
      decodeAddress(address);
    } catch (e) {
      sendMessage(roomId, `${sender} provided an incompatible address.`);
      return;
    }

    // Parity users can override the drip amount by using a 3rd argument
    if (sender.endsWith(':matrix.parity.io') && arg1) {
      dripAmount = Number(arg1);
    }

    ax.post<DripResponse>('/bot-endpoint', {
      address,
      amount: dripAmount,
      parachain_id,
      sender,
    })
      .then((res) => {
        // if hash is null or empty, something went wrong
        const message = isDripSuccessResponse(res.data)
          ? `Sent ${sender} ${dripAmount} ${unit}s. Extrinsic hash: ${res.data.hash}`
          : res.data.error ||
            'An unexpected error occured, please check the server logs';

        sendMessage(roomId, message);
      })
      .catch((e) => {
        sendMessage(
          roomId,
          (e as Error).message ||
            'An unexpected error occured, please check the server logs'
        );
        logger.error('⭕ An error occured when dripping', e);
      });
  } else if (action === '!help') {
    printHelpMessage(roomId);
  } else if (action.startsWith('!')) {
    printHelpMessage(roomId, 'Unknown command');
  }
});

bot.startClient({ initialSyncLimit: 0 }).catch((e) => logger.error(e));
