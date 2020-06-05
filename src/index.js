const taskcluster = require('taskcluster-client');
const assert = require('assert');
const chalk = require('chalk');
const aws = require('aws-sdk');
const {google} = require('googleapis');

const getProviderTypes = async wm => {
  const providerTypes = new Map();
  let query;
  while (true) {
    const res = await wm.listProviders(query);
    for (const {providerId, providerType} of res.providers) {
      providerTypes.set(providerId, providerType);
    }
    if (res.continuationToken) {
      query.continuationToken = res.continuationToken;
    } else {
      break;
    }
  }

  return providerTypes;
};

const getWorkerPools = async wm => {
  const workerPools = [];
  let query;
  while (true) {
    const res = await wm.listWorkerPools(query);
    for (const wp of res.workerPools) {
      workerPools.push(wp);
    }
    if (res.continuationToken) {
      query.continuationToken = res.continuationToken;
    } else {
      break;
    }
  }

  return workerPools;
};

const _aws = new Map();
const getAws = region => {
  if (!_aws.has(region)) {
    _aws.set(region, new aws.EC2({region}));
  }
  return _aws.get(region);
};

const _prices = new Map();
const getSpotPrice = async (instanceType, region, az) => {
  const key = `${az}/${instanceType}`;
  if (!_prices.has(key)) {
    const aws = getAws(region);
    const params = {
      InstanceTypes: [instanceType],
      ProductDescriptions: ['Linux/UNIX (Amazon VPC)'],
      Filters: [{
        Name: 'availability-zone',
        Values: [az],
      }],
      StartTime: new Date(),
      EndTime: new Date(),
    }
    const res = await aws.describeSpotPriceHistory(params).promise();
    const hist = res.SpotPriceHistory;
    if (hist.length == 0) {
      _prices.set(key, NaN); // signal that no price is defined
    } else if (hist.length > 1) {
      console.log(hist);
      assert(false);
    } else {
      _prices.set(key, hist[0].SpotPrice);
    }
  }
  return _prices.get(key);
};

let _client;
const getGcpClient = async () => {
  if (!_client) {
    _client = await google.auth.getClient();
  }
  return _client;
};

let _services;
const getGcpServices = async () => {
  if (!_services) {
    _services = [];
    const client = await getGcpClient();
    const cloudbilling = google.cloudbilling({version: 'v1', auth: client});
    const query = {};

    while (true) {
      const res = await cloudbilling.services.list(query);
      for (const svc of res.data.services) {
        _services.push(svc);
        console.log(svc);
      }

      if (res.nextPageToken) {
        query.pageToken = res.nextPageToken;
      } else {
        break;
      }
    }
  }

  return _services;
}

const getComputeServiceId = async () => {
  const services = await getGcpServices();
  for (const svc of services) {
    if (svc.config.name.startsWith('compute.')) {
      return svc.name;
    }
  }
  assert(false, 'not found');
};

const getGcpComputePrice = async (machineType, zone) => {
  //const serviceId = await getComputeServiceId();
  return NaN;
};

const main = async () => {
  const wm = new taskcluster.WorkerManager(taskcluster.fromEnvVars());
  const providerTypes = await getProviderTypes(wm);
  const workerPools = await getWorkerPools(wm);

  const priceRound = price => isNaN(price) ? 'N/A' : `USD $${Math.round(price * 10000) / 10000}/hr`;

  for (const wp of workerPools) {
    const providerType = providerTypes.get(wp.providerId);
    console.log(chalk`{yellow ${wp.workerPoolId}} (${providerType})`);

    if (providerType == 'static') {
      console.log(chalk`  No pricing for static worker pools`);
      continue;
    }

    let totalPrice = 0;
    let totalPricedConfigs = 0;
    for (const cfg of wp.config.launchConfigs || []) {
      let price, name;
      switch (providerType) {
        case 'google':
          const {machineType, zone} = cfg;
          price = await getGcpComputePrice(machineType, zone);
          name = `${zone} ${machineType}`;
          break;
        case 'aws':
          const {region, launchConfig: {InstanceType}} = cfg;
          const az = cfg.launchConfig.Placement.AvailabilityZone;
          assert(az, `worker pool ${wp.workerPoolId} config does not specify AZ`);
          price = await getSpotPrice(InstanceType, region, az);
          name = `${az} ${InstanceType}`;
          break;
      }

      const {capacityPerInstance} = cfg;
      if (!isNaN(price)) {
        totalPrice += price / capacityPerInstance;
        totalPricedConfigs += 1;
      }
      console.log(chalk`  {cyan ${name}} {magenta ${priceRound(price)}}${capacityPerInstance > 1 ? ` ÷ ${capacityPerInstance}` : ''}`);
    }
    console.log(chalk`  Average Price per Capacity: {magenta ${priceRound(totalPrice / totalPricedConfigs)}}`);
  }
};

main().catch(err => {
  console.log(err);
  process.exit(1);
});
