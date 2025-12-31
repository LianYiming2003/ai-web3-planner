// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract PlanManager {
    struct Plan {
        uint256 id;
        address owner;
        string ipfsHash;
        uint256 startTs;
        uint256 createdAt;
    }

    uint256 public nextPlan;
    mapping(uint256 => Plan) public plans;

    mapping(address => uint256[]) private planIdsByOwner;

    event PlanCreated(uint256 indexed id, address indexed owner, string ipfsHash, uint256 startTs);

    function createPlan(string calldata ipfsHash, uint256 startTs) external {
        uint256 id = ++nextPlan;
        plans[id] = Plan(id, msg.sender, ipfsHash, startTs, block.timestamp);
        planIdsByOwner[msg.sender].push(id);
        emit PlanCreated(id, msg.sender, ipfsHash, startTs);
    }

    function getPlansByOwner(address user) external view returns (Plan[] memory) {
        uint256[] storage ids = planIdsByOwner[user];
        Plan[] memory out = new Plan[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = plans[ids[i]];
        }
        return out;
    }
}
