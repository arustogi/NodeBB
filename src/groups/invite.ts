import * as _ from 'lodash';
import * as db from '../database';
import * as user from '../user';
import * as slugify from '../slugify';
import * as plugins from '../plugins';
import * as notifications from '../notifications';

interface Group {
    requestMembership(groupName: string, uid: number): Promise<void>;
    acceptMembership(groupName: string, uid: number): Promise<void>;
    rejectMembership(groupNames: string | string[], uid: number): Promise<void>;
    invite(groupName: string, uids: number | number[]): Promise<void>;
    isInvited(uids: number | number[], groupName: string): Promise<boolean | boolean[]>;
    isPending(uids: number | number[], groupName: string): Promise<boolean | boolean[]>;
    getPending(groupName: string): Promise<string[]>;
    getOwners(groupName: string): Promise<any>;
    join(groupName: string, uid: number): Promise<void>;
    isMembers(uids: number | number[], groupName: string): Promise<boolean | boolean[]>;
    exists(groupName: string): Promise<boolean>;
}

module.exports = function (Groups: Group) {
    async function inviteOrRequestMembership(groupName: string, uids:any, type) {
        uids = Array.isArray(uids) ? uids : [uids];
        uids = uids.filter(uid => parseInt(uid, 10) > 0);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const [exists, isMember, isPending, isInvited] = await Promise.all([
            Groups.exists(groupName),
            Groups.isMembers(uids, groupName),
            Groups.isPending(uids, groupName),
            Groups.isInvited(uids, groupName),
        ]);

        if (!exists) {
            throw new Error('[[error:no-group]]');
        }

        uids = uids.filter((uid, i) => !isMember[i] && ((type === 'invite' && !isInvited[i]) || (type === 'request' && !isPending[i])));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const set = type === 'invite' ? `group:${groupName}:invited` : `group:${groupName}:pending`;
        await db.setAdd(set, uids);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const hookName = type === 'invite' ? 'inviteMember' : 'requestMembership';
        plugins.hooks.fire(`action:group.${hookName}`, {
            groupName: groupName,
            uids: uids,
        });
        return uids;
    }

    Groups.requestMembership = async function (groupName : string, uid : number) {
        await inviteOrRequestMembership(groupName, uid, 'request');
        const { displayname } = await user.getUserFields(uid, ['username']);

        const [notification, owners] = await Promise.all([
            notifications.create({
                type: 'group-request-membership',
                bodyShort: `[[groups:request.notification_title, ${displayname}]]`,
                bodyLong: `[[groups:request.notification_text, ${displayname}, ${groupName}]]`,
                nid: `group:${groupName}:uid:${uid}:request`,
                path: `/groups/${slugify(groupName)}`,
                from: uid,
            }),
            Groups.getOwners(groupName),
        ]);

        await notifications.push(notification, owners);
    };

    Groups.acceptMembership = async function (groupName: string, uid: number) {
        await db.setsRemove([`group:${groupName}:pending`, `group:${groupName}:invited`], uid);
        await Groups.join(groupName, uid);

        const notification = await notifications.create({
            type: 'group-invite',
            bodyShort: `[[groups:membership.accept.notification_title, ${groupName}]]`,
            nid: `group:${groupName}:uid:${uid}:invite-accepted`,
            path: `/groups/${slugify(groupName)}`,
        });
        await notifications.push(notification, [uid]);
    };

    Groups.rejectMembership = async function (groupNames, uid) {
        if (!Array.isArray(groupNames)) {
            groupNames = [groupNames];
        }
        const sets = [];
        groupNames.forEach(groupName => sets.push(`group:${groupName}:pending`, `group:${groupName}:invited`));
        await db.setsRemove(sets, uid);
    };

    Groups.invite = async function (groupName, uids: any) {
        uids = Array.isArray(uids) ? uids : [uids];
        uids = await inviteOrRequestMembership(groupName, uids, 'invite');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const notificationData = await Promise.all(uids.map(uid => notifications.create({
            type: 'group-invite',
            bodyShort: `[[groups:invited.notification_title, ${groupName}]]`,
            bodyLong: '',
            nid: `group:${groupName}:uid:${uid}:invite`,
            path: `/groups/${slugify(groupName)}`,
        })));

        await Promise.all(uids.map((uid, index) => notifications.push(notificationData[index], uid)));
    };

    
    Groups.isInvited = async function (uids, groupName : string) {
        return await checkInvitePending(uids, `group:${groupName}:invited`);
    };

    Groups.isPending = async function (uids, groupName: string) {
        return await checkInvitePending(uids, `group:${groupName}:pending`);
    };

    async function checkInvitePending(uids, set) {
        const isArray = Array.isArray(uids);
        uids = isArray ? uids : [uids];
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const checkUids = uids.filter(uid => parseInt(uid, 10) > 0);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const isMembers = await db.isSetMembers(set, checkUids);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const map = _.zipObject(checkUids, isMembers);
        return isArray ? uids.map(uid => !!map[uid]) : !!map[uids[0]];
    }

    Groups.getPending = async function (groupName:string) {
        if (!groupName) {
            return [];
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        return await db.getSetMembers(`group:${groupName}:pending`);
    };
};
